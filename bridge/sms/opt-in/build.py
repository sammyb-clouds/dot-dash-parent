import sys
NUM = sys.argv[1] if len(sys.argv) > 1 else '(800) 555-0100'
html = r'''<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1200px;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;background:#f4f6fb;color:#1f2937;padding:48px}
h1{font-size:34px;font-weight:800;letter-spacing:-.5px}
.sub{font-size:18px;color:#4b5563;margin-top:10px;line-height:1.5;max-width:1040px}
.steps{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:36px}
.card{background:#fff;border-radius:20px;padding:26px;box-shadow:0 2px 10px rgba(0,0,0,.06);display:flex;flex-direction:column}
.n{display:inline-flex;width:36px;height:36px;border-radius:50%;background:#3b82f6;color:#fff;font-weight:800;font-size:18px;align-items:center;justify-content:center}
.who{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#3b82f6;margin-top:14px}
.t{font-size:21px;font-weight:800;margin-top:4px;line-height:1.25}
.d{font-size:15px;color:#4b5563;margin-top:10px;line-height:1.5}
.mock{margin-top:18px;border:1px solid #e5e7eb;border-radius:14px;padding:14px;background:#f9fafb;font-size:14px;flex:1}
.lbl{font-size:12px;color:#6b7280;margin-bottom:6px}
.inp{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-bottom:8px}
.note{background:#eff6ff;border:1px solid #dbeafe;color:#1e40af;border-radius:10px;padding:10px;margin-top:8px;line-height:1.45}
.btn{background:#3b82f6;color:#fff;font-weight:700;text-align:center;border-radius:10px;padding:8px}
.phone{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px;flex:1;margin-top:18px}
.to{font-size:12px;color:#6b7280;text-align:center;margin-bottom:12px}
.b{width:fit-content;max-width:88%;padding:10px 13px;border-radius:18px;font-size:15px;line-height:1.4;margin-bottom:8px}
.me{background:#3b82f6;color:#fff;margin-left:auto;border-bottom-right-radius:5px;font-weight:700}
.them{background:#e5e7eb;color:#111827;border-bottom-left-radius:5px}
.kw{margin-top:28px;background:#fff;border-radius:20px;padding:24px 28px;box-shadow:0 2px 10px rgba(0,0,0,.06);display:grid;grid-template-columns:repeat(4,1fr);gap:20px}
.kw b{display:block;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;margin-bottom:6px}
.kw div{font-size:15px;line-height:1.5}
code{font-family:"SF Mono",Menlo,monospace;background:#eef2ff;color:#3730a3;padding:1px 6px;border-radius:5px;font-weight:700}
.foot{margin-top:22px;font-size:14px;color:#6b7280;line-height:1.5}
</style></head><body>
<h1>Dot Dash: how a phone contact opts in to messages</h1>
<p class="sub">Dot Dash is a Morse-code messaging device. The account holder can approve a person's mobile phone to exchange messages with their Dot Dash.
<b>This is optional:</b> nobody has to receive SMS messages to use Dot Dash, and creating an account is not consent. <b>Consent comes only from the contact themselves:</b> Dot Dash never messages a phone number until that phone has sent the keyword <code>START</code> to __NUM__.</p>

<div class="steps">
 <div class="card">
  <span class="n">1</span><div class="who">Account holder, in the Dot Dash app</div>
  <div class="t">Account holder adds the contact</div>
  <div class="d">Optional: Settings › Contacts › Add a phone number. <b>Nothing is sent to the contact at this step.</b> The account holder can share an invite from their own phone.</div>
  <div class="mock">
   <div class="lbl">Their name</div><div class="inp">Grandma</div>
   <div class="lbl">Mobile number</div><div class="inp">(415) 555-0123</div>
   <div class="btn">Add</div>
   <div class="note">Now send Grandma the invite from your phone. Once they send START to __NUM__, they and Maya can message each other.<div class="btn" style="margin-top:8px">Send Grandma the invite</div></div>
  </div>
 </div>
 <div class="card">
  <span class="n">2</span><div class="who">Contact, on their own phone</div>
  <div class="t">Contact chooses to send START</div>
  <div class="d">A separate, voluntary step only the contact can take, from their own phone. Until they do, nothing is sent to them and nothing they send reaches the Dot Dash.</div>
  <div class="mock"><div class="lbl">Shown where they're asked to send START (the invite link and dotdashdevice.com):</div>
   <div class="note" style="margin-top:0"><b>By sending START, you agree to receive SMS messages from Dot Dash:</b> one confirmation, then the messages sent to you from that Dot Dash. Message frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to cancel. Terms &amp; Privacy: dotdashdevice.com</div>
  </div>
  <div class="phone"><div class="to">To: __NUM__</div>
   <div class="b me">START</div>
  </div>
 </div>
 <div class="card">
  <span class="n">3</span><div class="who">Automatic reply</div>
  <div class="t">Confirmation, with opt-out</div>
  <div class="d">The first message Dot Dash ever sends to the contact:</div>
  <div class="phone"><div class="to">From: __NUM__</div>
   <div class="b me">START</div>
   <div class="b them">Dot Dash: you're connected to Maya's Dot Dash. Messages from them will come from this number, so save it. Message frequency varies. Msg &amp; data rates may apply. Reply HELP for help, STOP to opt out.</div>
   <div class="to" style="margin-top:10px">Later, a typical message:</div>
   <div class="b them">Maya via Dot Dash: SEE YOU SUNDAY</div>
  </div>
 </div>
</div>

<div class="kw">
 <div><b>Opt in</b><code>START</code> (also YES, UNSTOP)</div>
 <div><b>Opt out</b><code>STOP</code> (also STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT). Stops all messages from this number.</div>
 <div><b>Help</b><code>HELP</code> (also INFO)</div>
 <div><b>Frequency</b>Varies: conversational messages, sent only when the Dot Dash sends one.</div>
</div>
<p class="foot">Program details, Privacy Policy and Terms: dotdashdevice.com. The account holder can remove a contact at any time in the app, which deletes the contact's phone number. A contact who hasn't sent START within 14 days is deleted automatically. Messages are never used for marketing, and phone numbers are never sold or shared with third parties for marketing.</p>
</body></html>'''
open('opt-in.html','w').write(html.replace('__NUM__', NUM))
