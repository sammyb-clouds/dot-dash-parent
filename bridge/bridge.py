#!/usr/bin/env python3
"""
Dot Dash push bridge.

    device -> mosquitto -> THIS -> FCM -> APNs -> parent's phone

Why it exists: iOS suspends the parent app in the background, taking its MQTT
connection with it, so the app cannot know that anything happened while the
phone is in a pocket. This process stays subscribed around the clock and
forwards the three events a parent actually needs to act on.

It cannot be a Cloud Function -- those are request-scoped and cannot hold a
persistent MQTT subscription -- so it runs on the droplet beside mosquitto.

Deliberately layered, so each stage can be proven before the next is wired:

    stage A  subscribe, parse, de-duplicate, log        (no credentials)
    stage B  + resolve child -> parent -> device tokens (needs a service account)
    stage C  + actually send                            (needs an APNs key)

Missing credentials downgrade the stage; they never crash the process. A bridge
that dies quietly is worse than no bridge, because alerts look like they work.
"""

import hashlib
import json
import logging
import os
import signal
import ssl
import sys
import time
from pathlib import Path

import paho.mqtt.client as mqtt

# ---------------------------------------------------------------- config ----
# Connect by HOSTNAME, not localhost: the listener presents a Let's Encrypt cert
# for app./mqtt.dotdashdevice.com, so "localhost" fails TLS hostname
# verification even from the box itself.
MQTT_HOST = os.environ.get("MQTT_HOST", "mqtt.dotdashdevice.com")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "8883"))
MQTT_USER = os.environ.get("MQTT_USER", "dotdash-bridge")
MQTT_PASS = os.environ.get("MQTT_PASS", "")
# Empty means the system CA store, which is right for a publicly trusted cert.
# Pointing at the deploy's chain.pem does NOT work -- that is the intermediate
# alone, with no root to anchor it.
MQTT_CA = os.environ.get("MQTT_CA", "")

# Set once a Firebase service account JSON is in place (stage B).
SERVICE_ACCOUNT = os.environ.get("SERVICE_ACCOUNT", "")
FIREBASE_PROJECT = os.environ.get("FIREBASE_PROJECT", "dotdash-6833f")
APP_ID = os.environ.get("APP_ID", "dotdash")

# Log what would be sent instead of sending it. Stays useful after stage C.
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"

STATE_PATH = Path(os.environ.get("STATE_PATH", "/root/dotdash_bridge/state.json"))

TOPIC = "doorbell/monitor/+/#"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("bridge")


# ------------------------------------------------------- replay guard ----
# Every topic this bridge listens to is RETAINED, so the broker redelivers each
# outstanding one on every reconnect. Without this, a restart would re-notify
# every parent about events they dismissed days ago -- and restarts are exactly
# what you do while developing.
#
# Keyed on topic -> digest of the payload, persisted. A redelivery of something
# already sent matches and is skipped; a value that CHANGED while the bridge was
# down does not match, and is delivered. Both are what you want.
class SeenStore:
    def __init__(self, path: Path):
        self.path = path
        self.data = {}
        try:
            self.data = json.loads(path.read_text())
            log.info("replay guard: loaded %d entries from %s", len(self.data), path)
        except FileNotFoundError:
            log.info("replay guard: no state yet at %s, starting empty", path)
        except Exception as e:
            log.warning("replay guard: could not read %s (%s), starting empty", path, e)

    def is_new(self, topic: str, payload: str) -> bool:
        digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
        if self.data.get(topic) == digest:
            return False
        self.data[topic] = digest
        self._save()
        return True

    def _save(self):
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data))
            tmp.replace(self.path)          # atomic, so a crash cannot truncate it
        except Exception as e:
            log.error("replay guard: could not persist state (%s)", e)


# ------------------------------------------------------------- events ----
def parse_event(topic: str, payload: str):
    """
    Return (kind, title, body, level) for a topic worth notifying about, else None.

    `level` is the APNs interruption-level, and it encodes urgency rather than
    importance. A friend request and a finished timer both have a child waiting
    on a parent to tap something, so they arrive normally. A flat battery is
    true for hours and needs no decision -- it goes out "passive": no sound, no
    vibration, no lit screen, just waiting in Notification Center. Same
    information, without buzzing a pocket at 3am over a battery.

    Topic shape: doorbell/monitor/<childHash>/<kind>[/<id>]

    Only the three NAMED kinds are alerts. The same prefix also carries a copy
    of every outgoing message on doorbell/monitor/<hash>/<timestamp> for the
    Monitor feed -- pushing those would notify a parent about each message their
    child sends, which is surveillance, not an alert.
    """
    parts = topic.split("/")
    if len(parts) < 4:
        return None
    kind = parts[3]

    fields = payload.split(",")
    tag = fields[0] if fields else ""

    if kind == "friendreq" and tag == "FRIENDREQ" and len(fields) >= 2:
        sender = fields[1]
        return ("friendreq",
                "New friend request",
                f"{sender} sent your child a message. Add them as a friend?",
                "active")

    if kind == "timerreq" and tag == "TIMERREQ" and len(fields) >= 3:
        minutes, points = fields[1], fields[2]
        return ("timerreq",
                "Timer completed",
                f"Your child finished a {minutes}-minute timer. Approve {points} points?",
                "active")

    if kind == "battery":
        if tag == "LOWBATT":
            return ("battery", "Low battery",
                    "Your child's Dot Dash needs charging.", "passive")
        # An empty payload is the device withdrawing the alert because it is on
        # charge again. Nothing to push -- but it still has to pass through the
        # replay guard so the NEXT genuine low reading is treated as new.
        return None

    return None


# ------------------------------------------------------------ delivery ----
def deliver(child_hash: str, kind: str, title: str, body: str, level: str):
    """
    Stage B/C. Until a service account is installed this only reports.

    When stage C lands, `level` goes into the APNs payload as
    aps.interruption-level. Note it has no Web Push equivalent: a browser or
    installed PWA has no notion of a passive notification, so the battery alert
    will be as loud as the others there until the platform offers a way to say
    otherwise.
    """
    if not SERVICE_ACCOUNT:
        log.info("  [stage A] no SERVICE_ACCOUNT set -- would notify "
                 "child=%s kind=%s level=%s title=%r",
                 child_hash[:12], kind, level, title)
        return
    if DRY_RUN:
        log.info("  [dry run] child=%s kind=%s level=%s title=%r body=%r",
                 child_hash[:12], kind, level, title, body)
        return
    log.warning("  stage C not implemented yet: child=%s kind=%s", child_hash[:12], kind)


# ---------------------------------------------------------------- mqtt ----
def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code != 0:
        log.error("MQTT connect refused: %s", reason_code)
        return
    log.info("connected to %s:%s as %s", MQTT_HOST, MQTT_PORT, MQTT_USER)
    client.subscribe(TOPIC, qos=1)
    log.info("subscribed to %s", TOPIC)


def on_disconnect(client, userdata, reason_code, properties=None, *args):
    # paho reconnects on its own via reconnect_delay_set; this is just visibility.
    log.warning("disconnected (%s) -- paho will retry", reason_code)


def on_message(client, userdata, msg):
    topic = msg.topic
    payload = msg.payload.decode("utf-8", errors="replace")
    seen: SeenStore = userdata["seen"]

    event = parse_event(topic, payload)

    # Record EVERY monitored topic, alert or not, so a cleared battery flag
    # updates the guard and the next genuine low reading counts as new.
    is_new = seen.is_new(topic, payload)

    if event is None:
        return
    if not is_new:
        log.debug("retained replay ignored: %s", topic)
        return

    kind, title, body, level = event
    child_hash = topic.split("/")[2]
    log.info("EVENT %-10s child=%s level=%-7s payload=%r",
             kind, child_hash[:12], level, payload)
    deliver(child_hash, kind, title, body, level)


def main():
    if not MQTT_PASS:
        log.error("MQTT_PASS is empty -- refusing to start. "
                  "Set it in the systemd EnvironmentFile.")
        return 2

    seen = SeenStore(STATE_PATH)
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"dotdash-bridge-{int(time.time())}",
        userdata={"seen": seen},
    )
    client.username_pw_set(MQTT_USER, MQTT_PASS)
    client.tls_set(ca_certs=(MQTT_CA or None), cert_reqs=ssl.CERT_REQUIRED,
                   tls_version=ssl.PROTOCOL_TLS_CLIENT)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=60)

    stage = "A (log only)" if not SERVICE_ACCOUNT else ("B (dry run)" if DRY_RUN else "C (sending)")
    log.info("dot dash push bridge starting -- stage %s", stage)

    def stop(signum, _frame):
        log.info("signal %s -- shutting down", signum)
        client.disconnect()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    client.loop_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
