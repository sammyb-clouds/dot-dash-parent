// Run: node app/bleSetup.test.mjs
import assert from 'node:assert/strict';
import {
  SEP, encodeMessage, parseMessage, pairingCodeFromName, parseHello, parseNet, dedupeNetworks,
  parseStatus, chooseDevices,
} from './src/bleSetup.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('encode joins with 0x1F and keeps empty fields', () => {
  assert.equal(encodeMessage('JOIN', 'Home', ''), `JOIN${SEP}Home${SEP}`);
  assert.equal(encodeMessage('HELLO'), 'HELLO');
  assert.equal(encodeMessage('SAVE', 'a', 'b', ''), `SAVE${SEP}a${SEP}b${SEP}`);
});

t('parseMessage splits and tolerates junk', () => {
  assert.deepEqual(parseMessage(`STATUS${SEP}FAILED${SEP}REJECTED`), { cmd: 'STATUS', args: ['FAILED', 'REJECTED'] });
  assert.deepEqual(parseMessage('SAVED\n'), { cmd: 'SAVED', args: [] });
  assert.deepEqual(parseMessage(''), { cmd: '', args: [] });
  assert.deepEqual(parseMessage(undefined), { cmd: '', args: [] });
});

t('pairing code from advertised name', () => {
  assert.equal(pairingCodeFromName('Dot Dash 1A2B3C'), '1A2B3C');
  assert.equal(pairingCodeFromName('Dot Dash 1a2b3c'), '1A2B3C');
  assert.equal(pairingCodeFromName('Dot Dash 12345'), '');
  assert.equal(pairingCodeFromName('Dot Dash 1A2B3CX'), '');
  assert.equal(pairingCodeFromName('Other 1A2B3C'), '');
  assert.equal(pairingCodeFromName(undefined), '');
});

t('HELLO reply', () => {
  assert.deepEqual(parseHello(parseMessage(`HELLO${SEP}1${SEP}1a2b3c${SEP}1`)), { proto: '1', code: '1A2B3C', needsConfirm: true });
  assert.equal(parseHello(parseMessage(`HELLO${SEP}1${SEP}1A2B3C${SEP}0`)).needsConfirm, false);
  assert.equal(parseHello(parseMessage(`ERR${SEP}LOCKED`)), null);
});

t('NET parsing', () => {
  assert.deepEqual(parseNet(parseMessage(`NET${SEP}-52${SEP}1${SEP}My Home`)), { rssi: -52, secured: true, ssid: 'My Home' });
  assert.deepEqual(parseNet(parseMessage(`NET${SEP}-80${SEP}0${SEP}Cafe`)), { rssi: -80, secured: false, ssid: 'Cafe' });
  assert.equal(parseNet(parseMessage(`NET${SEP}-80${SEP}0${SEP}`)), null);
  assert.equal(parseNet(parseMessage(`NET${SEP}-80`)), null);
  assert.equal(parseNet(parseMessage('SCAN_END')), null);
});

t('dedupe keeps the strongest and sorts by rssi', () => {
  const out = dedupeNetworks([
    { ssid: 'A', rssi: -70, secured: true },
    { ssid: 'B', rssi: -40, secured: true },
    { ssid: 'A', rssi: -55, secured: true },
    { ssid: 'C', rssi: -90, secured: false },
    { ssid: '', rssi: -10, secured: false },
  ]);
  assert.deepEqual(out.map((x) => [x.ssid, x.rssi]), [['B', -40], ['A', -55], ['C', -90]]);
});

t('STATUS parsing', () => {
  assert.deepEqual(parseStatus(parseMessage(`STATUS${SEP}CONNECTED${SEP}Home`)), { state: 'CONNECTED', ssid: 'Home' });
  assert.deepEqual(parseStatus(parseMessage(`STATUS${SEP}FAILED${SEP}not_found`)), { state: 'FAILED', reason: 'NOT_FOUND' });
  assert.deepEqual(parseStatus(parseMessage(`STATUS${SEP}FAILED`)), { state: 'FAILED', reason: 'TIMEOUT' });
  assert.equal(parseStatus(parseMessage('SAVED')), null);
});

t('chooseDevices: reconnect wants only its device, new lists all by strength', () => {
  const found = [
    { deviceId: 'x', code: 'AAAAAA', rssi: -80 },
    { deviceId: 'y', code: 'BBBBBB', rssi: -50 },
  ];
  assert.deepEqual(chooseDevices(found, 'aaaaaa').map((d) => d.code), ['AAAAAA']);
  assert.deepEqual(chooseDevices(found, 'CCCCCC'), []);
  assert.deepEqual(chooseDevices(found, '').map((d) => d.code), ['BBBBBB', 'AAAAAA']);
});

console.log(`${n} passed`);
