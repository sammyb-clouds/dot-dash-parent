# Third-Party Notices — Dot Dash Firmware

The Dot Dash firmware is proprietary (see `LICENSE`), but it is built against
third-party components that carry their own licences. Those licences govern
those components and are unaffected by the Dot Dash licence.

This list was compiled from the includes in `Globals.h` and the libraries
arduino-cli reports at build time. **It should be verified against a build log
before being relied on for a release** — versions move, and transitive
dependencies do not always announce themselves.

| Component | Used for | Licence |
|---|---|---|
| arduino-esp32 core (`WiFi`, `WebServer`, `DNSServer`, `WiFiClientSecure`, `Preferences`, `Wire`, `HTTPClient`, `HTTPUpdate`, `Update`, `Networking`, `AsyncUDP`, `FS`, `SPI`, `Hash`) | Board support, networking, storage, OTA | LGPL-2.1-or-later |
| ESP-IDF (underlying SDK, incl. mbedTLS for SHA-256) | RTOS, TLS, crypto | Apache-2.0 |
| PubSubClient — Nick O'Leary | MQTT client | MIT |
| Adafruit GFX Library | Display primitives and fonts | BSD-2-Clause |
| Adafruit SSD1306 | OLED driver | BSD-3-Clause |
| Adafruit BusIO | I²C/SPI abstraction | MIT |

## The LGPL component needs a decision, not just a notice

The arduino-esp32 core is **LGPL-2.1-or-later**, and Dot Dash ships as a single
statically-linked binary that includes it. The LGPL permits this, but it attaches
conditions to *distributing* such a binary — broadly, that a recipient must be
able to relink the work against a modified version of the LGPL library. In
practice that is usually met by publishing the object files or linkable
intermediates, or by a written offer to supply them.

Distributing firmware images publicly, as this project does, is exactly the
situation those conditions are written for. **This is worth raising with counsel
before a commercial release**; it is a licence-compliance question rather than a
technical one, and it does not go away by keeping the source private.

## Parent application

The web application loads its dependencies from public CDNs rather than bundling
them, so they are not redistributed by this project. As of this writing they are
Tailwind CSS (MIT), Babel standalone (MIT), MQTT.js (MIT), js-sha256 (MIT), and
the Firebase JavaScript SDK (Apache-2.0). React and its ecosystem, where used,
are MIT.

Loading from a CDN avoids redistribution obligations but creates a supply-chain
dependency: whatever those URLs serve is what runs in a parent's browser.
Pinning exact versions, and ideally adding Subresource Integrity hashes, is worth
doing for a product handling children's messages.
