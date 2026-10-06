/**
 * Dot Dash Connect: the iOS app as a chat client only, for someone who was sent
 * a link to message a Dot Dash (dotdashdevice.com/c/<token>) and has no account.
 *
 * Laid out like a simplified account-holder app (main.jsx): a Chat tab with
 * each Dot Dash as a pill across the top, as in ChatView, and a Settings tab
 * with a notifications switch and the list of chats -- same TabButton, same
 * icons, handed in by Root through `ui`.
 *
 * Underneath it is the native twin of site/c/index.html: same API (/chat/api/
 * on dotdashdevice.com, bridge/sms/service.mjs chatApi), same rules -- each link
 * is claimed by the first device to connect, and messages are cleaned to what a
 * Dot Dash can show. What the app adds: links open here directly (Universal
 * Links, handled in Root), and notifications are native Firebase pushes.
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';

const API = 'https://dotdashdevice.com/chat/api/';
const STORE = 'dotdash_contact_chats';
const PUSH_PREF = 'dotdash_contact_push';   // 'off' once the person switches notifications off here
const MAX = 160;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

// A link's token, from a full URL, a /c/ path, or text with the link in it.
export function tokenFromLink(text) {
  const m = /(?:\/c\/)?([A-Za-z0-9_-]{32})(?:[.#?/]|$)/.exec(String(text || '').trim());
  return m ? m[1] : null;
}

export function savedContactChats() {
  try { return (JSON.parse(localStorage.getItem(STORE) || '[]') || []).filter((c) => c && TOKEN_RE.test(c.token || '')); }
  catch (e) { return []; }
}

function call(method, route, body, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Chat ${auth}`;
  return fetch(API + route, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then((r) => r.json().catch(() => ({})).then((b) => ({ ...b, _status: r.status })));
}
const authOf = (c) => `${c.token}.${c.claim}`;

// lib.toDeviceText, for the "shows on the Dot Dash as" preview. The server's is
// the real one.
const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...',
  ',': ' ', '\n': ' ', '\r': ' ', '\t': ' ', '|': '/', '<': '(', '>': ')', '[': '(', ']': ')', '{': '(', '}': ')', '%': ' PERCENT', '*': ' ' };
const OK = /[A-Z0-9 .:?'\-/()"=+@!;_$&]/;
function deviceText(s) {
  let out = '';
  for (const ch of String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')) {
    const up = ch.toUpperCase();
    if (FOLD[ch] !== undefined) out += FOLD[ch]; else if (up.length === 1 && OK.test(up)) out += up;
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (!out && String(s || '').trim()) out = '(EMOJI)';
  return out;
}

const msgKey = (m) => `${m.at}|${m.from}|${m.text}`;
// "Maya's Dot Dash" -> "Maya" for the pills, as ChatView shows a name.
const shortName = (c) => String(c?.displayName || 'Dot Dash').replace(/['’]s Dot Dash$/i, '') || 'Dot Dash';
const stamp = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const Logo = ({ size = 'w-24 h-24' }) => <img src="icon.jpg" alt="Dot Dash" className={`${size} rounded-3xl shadow-md object-cover mx-auto`} />;

/**
 * incoming: { token?, chat?, n } -- a link or notification tap from Root; `n`
 *   changes on every event so the same link twice still acts.
 * ownerSignedIn: show a way back to the account holder's side of the app.
 * onExit: leave Connect for the account holder's side (set up / sign in).
 * onWelcome: back to the Welcome chooser -- for someone who picked "Someone
 *   invited me to chat" and has no chat yet.
 * ui: { TabButton, MessageCircle, SettingsIcon, Send, Trash2, Plus, Bell, ArrowLeft } from main.jsx.
 *
 * Every screen that is not one of the two tabs has a Back button at top left,
 * drawn like the account-holder app's (BackBar).
 */
export default function ContactApp({ incoming, ownerSignedIn, onExit, onWelcome, ui }) {
  const { TabButton, MessageCircle, SettingsIcon, Send, Trash2, Plus, Bell, ArrowLeft } = ui;
  const [chats, setChats] = useState(savedContactChats);
  const [msgs, setMsgs] = useState({});                  // token -> messages (render copy)
  const msgsRef = useRef({});                            // the same, read synchronously by the polls
  const setAllMsgs = (next) => { msgsRef.current = next; setMsgs(next); };
  // main = the tabs; the rest are full-screen steps: loading | error | gone | left | claimed | join | add
  const [view, setView] = useState({ name: 'boot' });
  const [tab, setTab] = useState('chat');
  const [active, setActive] = useState(null);            // token of the chat on screen
  const [pushState, setPushState] = useState('unknown'); // unknown | prompt | granted | denied | unavailable
  const [pushOn, setPushOn] = useState(() => { try { return localStorage.getItem(PUSH_PREF) !== 'off'; } catch (e) { return true; } });
  const chatsRef = useRef(chats); chatsRef.current = chats;
  const stateRef = useRef({}); stateRef.current = { view, tab, active };
  const polls = useRef({});
  const leaving = useRef({});

  const persist = useCallback((next) => {
    setChats(next);
    chatsRef.current = next;
    try { localStorage.setItem(STORE, JSON.stringify(next)); } catch (e) {}
  }, []);
  const upsert = useCallback((patch) => {
    const list = chatsRef.current;
    const i = list.findIndex((c) => c.token === patch.token);
    persist(i >= 0 ? list.map((c, j) => (j === i ? { ...c, ...patch } : c)) : [...list, patch]);
  }, [persist]);
  const drop = useCallback((token) => {
    polls.current[token] = false;
    persist(chatsRef.current.filter((c) => c.token !== token));
    const n = { ...msgsRef.current }; delete n[token]; setAllMsgs(n);
  }, [persist]);
  const byToken = (t) => chatsRef.current.find((c) => c.token === t);
  const live = () => chatsRef.current.filter((c) => c.claim && !c.ended);
  const isReading = (token) => {
    const s = stateRef.current;
    return s.view.name === 'main' && s.tab === 'chat' && s.active === token && !document.hidden;
  };

  const openChat = useCallback((token) => { setActive(token); setTab('chat'); setView({ name: 'main' }); }, []);
  // The tabs, on the most recent chat unless one is already on screen.
  const home = useCallback(() => {
    const l = chatsRef.current.filter((c) => c.claim).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const keep = l.find((c) => c.token === stateRef.current.active);
    setActive(keep ? keep.token : (l[0]?.token || null));
    setView({ name: 'main' });
  }, []);

  // ------------------------------------------------------------ messages --
  const received = useCallback((token, list) => {
    if (!list || !list.length) return;
    const have = msgsRef.current[token] || [];
    const seen = new Set(have.map(msgKey));
    const merged = [...have, ...list.filter((m) => !seen.has(msgKey(m)))].sort((a, b) => a.at - b.at);
    setAllMsgs({ ...msgsRef.current, [token]: merged });
    const last = merged[merged.length - 1];
    upsert({ token, lastAt: last.at, lastText: last.text, lastFrom: last.from, ...(isReading(token) ? { readAt: last.at } : {}) });
  }, [upsert]);   // eslint-disable-line react-hooks/exhaustive-deps

  const ended = useCallback((token) => {
    if (leaving.current[token]) return;
    polls.current[token] = false;
    if (isReading(token)) { drop(token); setView({ name: 'gone' }); }
    else upsert({ token, ended: true });
  }, [drop, upsert]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Our claim no longer matches (another device took the link, or it was
  // released). If the link is free again, offer Connect.
  const staleClaim = useCallback((token) => {
    if (leaving.current[token]) return;
    polls.current[token] = false;
    upsert({ token, claim: null });
    if (stateRef.current.active === token) openLink(token);   // eslint-disable-line no-use-before-define
  }, [upsert]);   // eslint-disable-line react-hooks/exhaustive-deps

  const loadHistory = useCallback(async (token) => {
    const c = byToken(token);
    if (!c?.claim) return false;
    try {
      const r = await call('GET', 'history', null, authOf(c));
      if (r._status === 403) { staleClaim(token); return false; }
      if (r._status === 410 || r._status === 401) { ended(token); return false; }
      if (r._status !== 200) return false;
      upsert({ token, id: r.id, displayName: r.displayName, contactName: r.contactName });
      setAllMsgs({ ...msgsRef.current, [token]: r.messages || [] });
      const last = (r.messages || []).slice(-1)[0];
      if (last) upsert({ token, lastAt: last.at, lastText: last.text, lastFrom: last.from });
      return true;
    } catch (e) { return false; }
  }, [ended, staleClaim, upsert]);   // eslint-disable-line react-hooks/exhaustive-deps

  // One long poll per connected chat while the app is open; push covers the
  // rest. The server answers when something arrives, or after ~25s.
  const startPoll = useCallback((token) => {
    if (polls.current[token]) return;
    polls.current[token] = true;
    (async () => {
      if (!(await loadHistory(token))) { polls.current[token] = false; return; }
      while (polls.current[token] && !leaving.current[token]) {
        const c = byToken(token);
        if (!c?.claim) break;
        const after = (msgsRef.current[token] || []).reduce((a, m) => Math.max(a, m.at), 0);
        try {
          const r = await call('GET', `wait?after=${after}`, null, authOf(c));
          if (leaving.current[token]) break;
          if (r._status === 410) { ended(token); break; }
          if (r._status === 403) { staleClaim(token); break; }
          received(token, r.messages);
          if (r._status !== 200) await new Promise((res) => setTimeout(res, 5000));
        } catch (e) { await new Promise((res) => setTimeout(res, 5000)); }
      }
      polls.current[token] = false;
    })();
  }, [loadHistory, received, ended, staleClaim]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- push --
  // One Firebase token for the whole app; every chat on this phone is told it.
  // Switching notifications off here tells every chat to forget it -- iOS
  // permission itself can only be withdrawn in the Settings app.
  const registerPush = useCallback(async (ask) => {
    let wanted = true;
    try { wanted = localStorage.getItem(PUSH_PREF) !== 'off'; } catch (e) {}
    try {
      const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
      let perm = await FirebaseMessaging.checkPermissions();
      if (perm.receive === 'prompt' && ask && wanted) perm = await FirebaseMessaging.requestPermissions();
      setPushState(perm.receive === 'granted' ? 'granted' : perm.receive === 'denied' ? 'denied' : 'prompt');
      if (perm.receive !== 'granted' || !wanted) return;
      const { token } = await FirebaseMessaging.getToken();
      if (!token) return;
      await Promise.all(live().map((c) => call('POST', 'push', { fcmToken: token }, authOf(c))));
    } catch (e) { setPushState('unavailable'); }
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const setNotifications = useCallback(async (on) => {
    setPushOn(on);
    try { if (on) localStorage.removeItem(PUSH_PREF); else localStorage.setItem(PUSH_PREF, 'off'); } catch (e) {}
    if (on) return registerPush(true);
    await Promise.all(live().map((c) => call('DELETE', 'push', null, authOf(c)).catch(() => {})));
  }, [registerPush]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------- joining a chat --
  const openLink = useCallback(async (token) => {
    const saved = byToken(token);
    if (saved?.claim) { openChat(token); return; }
    setView({ name: 'loading' });
    try {
      const r = await call('POST', 'open', { token });
      if (r._status === 410) return setView({ name: 'gone' });
      if (r._status !== 200) return setView({ name: 'error' });
      if (r.state === 'claimed') return setView({ name: 'claimed' });
      setView({ name: 'join', token, info: r });
    } catch (e) { setView({ name: 'error' }); }
  }, [openChat]);   // eslint-disable-line react-hooks/exhaustive-deps

  const claim = useCallback(async (token) => {
    try {
      const r = await call('POST', 'claim', { token });
      if (r._status === 200) {
        upsert({ token, claim: r.claim, id: r.id, displayName: r.displayName, contactName: r.contactName, ended: false });
        openChat(token);
        startPoll(token);
        registerPush(true);
      } else if (r._status === 409) setView({ name: 'claimed' });
      else if (r._status === 410) setView({ name: 'gone' });
      else setView({ name: 'error' });
    } catch (e) { setView({ name: 'error' }); }
  }, [upsert, openChat, startPoll, registerPush]);

  const leave = useCallback(async (c) => {
    if (!window.confirm(`Leave your chat with ${c.displayName}? It won't be able to message you, and your link will stop working.`)) return false;
    leaving.current[c.token] = true;
    if (c.claim && !c.ended) { try { await call('POST', 'leave', null, authOf(c)); } catch (e) {} }
    drop(c.token);
    return true;
  }, [drop]);

  // ---------------------------------------------------------------- boot --
  useEffect(() => {
    live().forEach((c) => startPoll(c.token));
    registerPush(false);
    if (!incoming?.token && !incoming?.chat) home();
    return () => { Object.keys(polls.current).forEach((t) => { polls.current[t] = false; }); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // A link tapped, or a notification tapped, while in (or entering) Connect.
  useEffect(() => {
    if (!incoming) return;
    if (incoming.token) openLink(incoming.token);
    else if (incoming.chat) {
      const c = chatsRef.current.find((x) => x.id === incoming.chat);
      if (c?.claim) openChat(c.token); else home();
    }
  }, [incoming?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Back in the foreground: restart any polls iOS paused, refresh the token.
  useEffect(() => {
    const onVis = () => { if (!document.hidden) { live().forEach((c) => startPoll(c.token)); registerPush(false); } };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [startPoll, registerPush]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The chat on screen is read; a chat that vanished gives way to another.
  useEffect(() => {
    if (view.name !== 'main') return;
    const c = active && byToken(active);
    if (active && !c) { home(); return; }
    if (tab === 'chat' && c && c.lastAt && c.readAt !== c.lastAt) upsert({ token: c.token, readAt: c.lastAt });
  }, [view, tab, active, chats]);   // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------- render --
  const center = (children, onBack) => (
    <div className="min-h-screen bg-[#f2f2f7] flex flex-col" style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}>
      {onBack && <BackBar onBack={onBack} ArrowLeft={ArrowLeft} />}
      <div className="flex-1 flex flex-col justify-center items-center text-center px-6 py-10 space-y-4">{children}</div>
    </div>
  );
  const backButton = live().length > 0 && (
    <button onClick={home} className="w-full max-w-sm bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">Back to your chats</button>
  );

  if (view.name === 'boot' || view.name === 'loading') return center(<p className="text-gray-400">Loading…</p>);

  if (view.name === 'error') return center(<>
    <Logo /><h1 className="text-2xl font-bold">Can't connect right now</h1>
    <p className="text-gray-500">Check your connection and try again.</p>
    <button onClick={home} className="w-full max-w-sm bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">Try again</button>
  </>, home);

  if (view.name === 'gone' || view.name === 'left') return center(<>
    <Logo /><h1 className="text-2xl font-bold">{view.name === 'left' ? "You've left the chat" : 'This link has expired'}</h1>
    <p className="text-gray-500">{view.name === 'left'
      ? 'Nothing more will reach this phone. To message again, ask for a new link.'
      : 'It may have been replaced with a new one, or the chat was ended. Ask whoever sent it for a new link.'}</p>
    {backButton || <button onClick={home} className="w-full max-w-sm bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">OK</button>}
  </>, home);

  if (view.name === 'claimed') return center(<>
    <Logo /><h1 className="text-2xl font-bold">Already connected on another device</h1>
    <p className="text-gray-500">Each link works on one device. If you opened it in Safari first, open it there and tap "Move this chat", or ask whoever sent it for a new link.</p>
    {backButton || <button onClick={home} className="w-full max-w-sm bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">OK</button>}
  </>, home);

  if (view.name === 'join') {
    const { info, token } = view;
    return center(<>
      <Logo />
      <h1 className="text-2xl font-bold">Hi {info.contactName}!</h1>
      <p className="text-gray-500">You're invited to message <b className="text-gray-700">{info.displayName}</b>, a Morse-code messaging device. Messages you send here show up on its screen, and its replies show up here.</p>
      <p className="text-gray-400 text-sm">This link works on one device only.</p>
      <button onClick={(e) => { e.currentTarget.disabled = true; claim(token); }} className="w-full max-w-sm bg-blue-500 text-white font-bold py-4 rounded-2xl disabled:bg-blue-300">Connect</button>
      <p className="text-gray-400 text-sm">You can leave the chat at any time.</p>
    </>, home);
  }

  if (view.name === 'add') return <AddChat onBack={home} onToken={openLink} ArrowLeft={ArrowLeft} />;

  // ---- the tabs
  const rows = chats.filter((c) => c.claim);
  const unreadCount = (c) => {
    if (c.ended) return 0;
    const list = msgs[c.token];
    if (list) return list.filter((m) => m.from === 'dotdash' && m.at > (c.readAt || 0)).length;
    return c.lastFrom === 'dotdash' && (c.lastAt || 0) > (c.readAt || 0) ? 1 : 0;
  };
  const totalUnread = rows.reduce((n, c) => n + (c.token === active && tab === 'chat' ? 0 : (unreadCount(c) ? 1 : 0)), 0);
  const current = rows.find((c) => c.token === active) || null;

  return (
    <div className="flex flex-col h-screen w-full bg-[#f2f2f7] text-black font-sans overflow-hidden">
      <div className="flex-1 flex flex-col px-4 overflow-hidden" style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}>
        {tab === 'chat' && (rows.length
          ? <ChatTab rows={rows} current={current} messages={(current && msgs[current.token]) || []} unreadCount={unreadCount}
              onPick={(t) => { const c = byToken(t); if (c?.ended) { drop(t); setView({ name: 'gone' }); } else setActive(t); }}
              onAdd={() => setView({ name: 'add' })}
              onSent={(m) => current && received(current.token, [m])}
              onEnded={() => current && ended(current.token)}
              onStale={() => current && staleClaim(current.token)}
              icons={{ Send, Plus }} />
          : <Waiting onPaste={() => setView({ name: 'add' })} onBack={onWelcome} onOwner={onExit} ArrowLeft={ArrowLeft} />)}
        {tab === 'settings' && (
          <SettingsTab rows={rows} pushOn={pushOn} pushState={pushState} onPush={setNotifications}
            onLeave={async (c) => { if (await leave(c) && active === c.token) setActive(null); }}
            onAdd={() => setView({ name: 'add' })} ownerSignedIn={ownerSignedIn} onExit={onExit}
            icons={{ Trash2, Plus, Bell, MessageCircle }} />
        )}
      </div>

      <div className="shrink-0 w-full bg-[#f8f8f8]/90 backdrop-blur-md border-t border-gray-300 pt-2 px-4 flex justify-around items-center" style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}>
        <TabButton icon={<MessageCircle className="w-6 h-6" />} label="Chat" active={tab === 'chat'} onClick={() => setTab('chat')} badge={totalUnread} />
        <TabButton icon={<SettingsIcon className="w-6 h-6" />} label="Settings" active={tab === 'settings'} onClick={() => setTab('settings')} />
      </div>
    </div>
  );
}

// No chats yet: someone who chose "Someone invited me to chat" before their link
// arrived. Tell them what to wait for, so they don't go looking for an account.
function Waiting({ onPaste, onBack, onOwner, ArrowLeft }) {
  return (
    <div className="flex-1 flex flex-col">
    {onBack && <BackBar onBack={onBack} ArrowLeft={ArrowLeft} flush />}
    <div className="flex-1 flex flex-col justify-center items-center text-center px-2 space-y-4">
      <Logo />
      <h1 className="text-2xl font-bold">Chat with a Dot Dash</h1>
      <p className="text-gray-500">You need a link from the person whose Dot Dash you'll be chatting with. They can send it to you from their Dot Dash app.</p>
      <div className="w-full max-w-sm bg-white border border-gray-100 rounded-2xl p-4 text-left text-sm text-gray-600">
        <b className="text-gray-800">When your link arrives,</b> just tap it and it opens here. No account or sign-in needed.
      </div>
      <button onClick={onPaste} className="w-full max-w-sm bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">I have a link to paste</button>
      <button onClick={onOwner} className="text-sm text-gray-500 underline pt-2">I have a Dot Dash</button>
    </div>
    </div>
  );
}

// The account-holder app's Back button (AuthScreen), as a bar rather than
// absolutely placed so it never sits under the notch.
function BackBar({ onBack, ArrowLeft, flush = false }) {
  return (
    <div className={flush ? '' : 'px-4'}>
      <button onClick={onBack} className="p-2 -ml-2 text-gray-500 font-bold flex items-center active:text-gray-700">
        {ArrowLeft ? <ArrowLeft className="w-5 h-5 mr-1" /> : '‹ '}Back
      </button>
    </div>
  );
}

// ChatView from main.jsx, simplified: the Dot Dashes as pills across the top,
// the conversation, and the round input bar.
function ChatTab({ rows, current, messages, unreadCount, onPick, onAdd, onSent, onEnded, onStale, icons }) {
  const { Send, Plus } = icons;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, current?.token]);

  const preview = deviceText(text);
  const send = async () => {
    if (!current || !text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await call('POST', 'send', { text }, authOf(current));
      if (r._status === 200) { setText(''); onSent(r.message); }
      else if (r._status === 429) alert('That\'s a lot of messages at once. Wait a minute and try again.');
      else if (r._status === 410) onEnded();
      else if (r._status === 403) onStale();
      else if (r.status !== 'empty') alert('Couldn\'t send. Check your connection and try again.');
    } catch (e) { alert('Couldn\'t send. Check your connection and try again.'); }
    setBusy(false);
  };

  return (
    <div className="flex flex-col h-full relative">
      <div className="shrink-0 flex space-x-3 overflow-x-auto pb-4 pt-2 mb-2 border-b border-gray-200" style={{ scrollbarWidth: 'none' }}>
        {rows.map((c) => {
          const isActive = current?.token === c.token;
          const n = isActive ? 0 : unreadCount(c);
          return (
            <button key={c.token} onClick={() => onPick(c.token)}
              className={`px-5 py-2.5 rounded-full font-bold flex flex-shrink-0 items-center space-x-2 transition-all duration-200 shadow-sm ${isActive ? 'bg-blue-500 text-white' : 'bg-white text-gray-500 border border-gray-100'} ${c.ended ? 'opacity-50' : ''}`}>
              <span>{shortName(c)}</span>
              {n > 0 && (
                <span className="bg-red-500 text-white text-xs font-bold min-w-[20px] h-[20px] px-1.5 flex items-center justify-center rounded-full">{n > 99 ? '99+' : n}</span>
              )}
            </button>
          );
        })}
        <button onClick={onAdd} aria-label="Add a chat" className="px-4 py-2.5 rounded-full font-bold flex flex-shrink-0 items-center bg-white text-blue-500 border border-dashed border-blue-200 shadow-sm">
          <Plus className="w-5 h-5" />
        </button>
      </div>

      {!current
        ? <p className="text-center text-gray-400 mt-10">Pick a Dot Dash above.</p>
        : <>
          <div className="flex-1 overflow-y-auto space-y-4 pb-4">
            {messages.length === 0 && <p className="text-center text-gray-400 mt-10">No messages yet with {shortName(current)}. Say hello! Your messages appear on its screen.</p>}
            {messages.map((m) => (
              <div key={msgKey(m)} className={`flex flex-col ${m.from === 'contact' ? 'items-end' : 'items-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-3 break-words ${m.from === 'contact' ? 'bg-blue-500 text-white' : 'bg-white text-black shadow-sm border border-gray-100'}`}>{m.text}</div>
                <span className="text-xs text-gray-400 mt-1 px-1">{stamp(m.at)}</span>
              </div>
            ))}
            <div ref={end} />
          </div>

          <div className="shrink-0 bg-[#f2f2f7] pt-2 pb-2">
            <div className="flex items-center space-x-2 bg-white rounded-full px-4 py-2 shadow-sm border border-gray-200">
              <input type="text" placeholder="Message..." value={text} maxLength={400}
                onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
                className="flex-1 outline-none bg-transparent py-1 text-lg min-w-0" />
              <button onClick={send} disabled={busy || !text.trim()} aria-label="Send" className="bg-blue-500 text-white p-2 rounded-full disabled:bg-blue-300 flex-shrink-0 transition-opacity">
                <Send className="w-5 h-5 ml-0.5" />
              </button>
            </div>
            <div className="text-xs text-gray-500 min-h-[16px] mt-1 px-3">
              {text.trim() && preview !== text.trim() && <>Shows on the Dot Dash as: <b>{preview.slice(0, MAX)}</b></>}
              {preview.length > MAX && <span className="text-amber-600"> (too long: it will be cut to {MAX} letters)</span>}
            </div>
          </div>
        </>}
    </div>
  );
}

// SettingsView from main.jsx, simplified: notifications, the chats on this
// phone, and the way to the account holder's side.
function SettingsTab({ rows, pushOn, pushState, onPush, onLeave, onAdd, ownerSignedIn, onExit, icons }) {
  const { Trash2, Plus, Bell, MessageCircle } = icons;
  const on = pushOn && pushState === 'granted';
  return (
    <div className="h-full overflow-y-auto pb-4 space-y-4">
      <h1 className="text-2xl font-bold pt-2">Dot Dash Connect</h1>

      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <div className="flex items-center">
          <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shrink-0"><Bell className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0 mx-3">
            <div className="font-bold text-gray-800">Notifications</div>
            <div className="text-xs text-gray-500">{on ? 'You\'ll be told when a Dot Dash messages you.' : pushState === 'denied' ? 'Turned off for Dot Dash in the iPhone Settings app.' : 'Off. Messages still arrive here.'}</div>
          </div>
          <button role="switch" aria-checked={on} aria-label="Notifications" disabled={pushState === 'denied' || pushState === 'unavailable'}
            onClick={() => onPush(!on)}
            className={`relative shrink-0 w-14 h-8 rounded-full transition-colors duration-200 disabled:opacity-50 ${on ? 'bg-green-500' : 'bg-gray-300'}`}>
            <span className={`absolute top-1 left-1 w-6 h-6 bg-white rounded-full shadow transition-transform duration-200 ${on ? 'translate-x-6' : 'translate-x-0'}`} />
          </button>
        </div>
        {pushState === 'denied' && <p className="text-xs text-gray-500 mt-3">To turn them back on, open the iPhone Settings app, then Notifications, then Dot Dash.</p>}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <div className="flex items-center mb-3">
          <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shrink-0"><MessageCircle className="w-5 h-5" /></div>
          <div className="flex-1 min-w-0 mx-3">
            <div className="font-bold text-gray-800">Your chats</div>
            <div className="text-xs text-gray-500">{rows.length === 1 ? '1 Dot Dash' : `${rows.length} Dot Dashes`}</div>
          </div>
        </div>
        <div className="space-y-2">
          {rows.map((c) => (
            <div key={c.token} className="flex items-center bg-gray-50 rounded-xl px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="font-bold text-gray-700 truncate">{c.displayName}</div>
                <div className="text-xs text-gray-400">{c.ended ? 'This chat has ended' : 'Connected'}</div>
              </div>
              <button onClick={() => onLeave(c)} aria-label={`Leave chat with ${c.displayName}`} className="text-red-400 hover:text-red-600 p-1 ml-2 shrink-0 active:scale-95 transition-transform">
                <Trash2 className="w-5 h-5" />
              </button>
            </div>
          ))}
          {rows.length === 0 && <p className="text-sm text-gray-400">No chats yet. When someone sends you a link, tap it and it appears here.</p>}
        </div>
        <button onClick={onAdd} className="w-full flex items-center justify-center space-x-2 text-blue-600 font-bold text-sm py-2 mt-3 rounded-xl border border-dashed border-blue-200 active:bg-blue-50">
          <Plus className="w-4 h-4" /><span>Add a chat</span>
        </button>
      </div>

      {/* The way over to the account holder's side: for someone who started
          here only to chat, and has since got a Dot Dash of their own. */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4">
        <div className="font-bold text-gray-800">{ownerSignedIn ? 'Your Dot Dash' : 'Got your own Dot Dash?'}</div>
        <div className="text-xs text-gray-500 mt-1">{ownerSignedIn
          ? 'Switch to the side of the app where you manage your Dot Dash. Your chats here stay as they are.'
          : 'Set it up and manage it from this app. Your chats here stay as they are, and you can come back to them any time.'}</div>
        <button onClick={onExit} className="w-full mt-3 bg-blue-500 text-white font-bold py-3 rounded-xl active:bg-blue-600">
          {ownerSignedIn ? 'Go to My Dot Dash' : 'Set it up or sign in'}
        </button>
      </div>

      <div className="text-center text-sm text-gray-500 pt-2">
        <a href="https://dotdashdevice.com/privacy.html" className="underline">Privacy</a> · <a href="https://dotdashdevice.com/terms.html" className="underline">Terms</a>
      </div>
    </div>
  );
}

function AddChat({ onBack, onToken, ArrowLeft }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const paste = async () => {
    try { setText((await navigator.clipboard.readText()).trim()); }
    catch (e) { setNote('Couldn\'t paste. Press and hold in the box, then tap Paste.'); }
  };
  const go = () => {
    const t = tokenFromLink(text);
    if (!t) return setNote('That doesn\'t look like a Dot Dash link.');
    onToken(t);
  };
  return (
    <div className="min-h-screen bg-[#f2f2f7] flex flex-col" style={{ paddingTop: 'max(env(safe-area-inset-top), 1rem)' }}>
      <BackBar onBack={onBack} ArrowLeft={ArrowLeft} />
      <div className="px-6 py-4 space-y-3">
        <h1 className="text-2xl font-bold">Add a chat</h1>
        <p className="text-gray-500">Paste the Dot Dash link you were sent.</p>
        <input value={text} onChange={(e) => { setText(e.target.value); setNote(''); }} placeholder="https://dotdashdevice.com/c/…" autoCapitalize="off" autoCorrect="off" spellCheck="false"
          className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 outline-none" />
        <button onClick={paste} className="w-full bg-white border border-gray-200 text-blue-500 font-bold py-3 rounded-2xl">Paste</button>
        <button onClick={go} className="w-full bg-blue-500 text-white font-bold py-4 rounded-2xl">Connect</button>
        {note && <p className="text-sm text-gray-500">{note}</p>}
      </div>
    </div>
  );
}
