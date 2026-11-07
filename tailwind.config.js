/** @type {import('tailwindcss').Config} */
// Tailwind 3 on purpose, not 4. The app's look is already settled, and v4
// renamed parts of the shadow scale and changed the default border colour --
// small regressions across a UI this size, for no gain here.
//
// The `extend` below is the Dot Dash brand layer's Tailwind half: every entry
// resolves to a CSS custom property declared in app/src/index.css, which in
// turn mirrors the `:root` blocks in site/index.html and site/faq/index.html.
// Nothing here REPLACES a Tailwind default, so main.jsx keeps working untouched
// -- these are additional names, available to any file that wants them. Stage
// one (ContactApp.jsx) uses them; stage two is renaming main.jsx's classes onto
// them.
//
// One caveat worth knowing before stage two: a colour defined as a bare var()
// cannot take Tailwind's slash-opacity modifier (`bg-card/70` will not work).
// That is why --accent-soft exists as its own token rather than as bg-accent/16.
export default {
  content: ['./app/index.html', './app/src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ground: 'var(--bg)',          // the page behind everything
        card:   'var(--card)',        // a raised surface
        sunken: 'var(--sunken)',      // a recessed row inside a card
        ink:    'var(--ink)',         // primary text
        muted:  'var(--muted)',       // secondary text
        rule:   'var(--rule)',        // hairline separator
        accent: {                     // interactive affordance ONLY -- never a brand colour
          DEFAULT: 'var(--accent)',
          ink:     'var(--accent-ink)',
          soft:    'var(--accent-soft)',
        },
        sent: {                       // outgoing chat bubble
          DEFAULT: 'var(--sent)',
          ink:     'var(--sent-ink)',
        },
        recv: {                       // incoming chat bubble
          DEFAULT: 'var(--recv)',
          ink:     'var(--recv-ink)',
        },
        alert: {                       // unread badge
          DEFAULT: 'var(--alert)',
          ink:     'var(--alert-ink)',
        },
        ok:     'var(--ok)',          // a switch that is on
        warn:   'var(--warn)',        // a caution that is not an error
        danger: 'var(--danger)',      // a destructive action
        screen: {                     // the 128x32 device screen, drawn on the web
          DEFAULT: 'var(--screen)',   // the unlit panel -- no dark sibling, ever
          ink:     'var(--screen-ink)',
          edge:    'var(--screen-edge)',
        },
      },
      fontFamily: {
        // Deliberately NOT overriding `sans`: that would restyle every
        // font-sans in main.jsx, which is out of scope for stage one.
        body:   ['"Atkinson Hyperlegible Next"', 'ui-sans-serif', '-apple-system', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        // Reserved role, per the brief: anything on screen that represents what
        // a Dot Dash itself is showing. Never paragraphs.
        device: ['"Departure Mono"', 'ui-monospace', '"SF Mono"', 'Menlo', 'monospace'],
      },
      borderRadius: {
        card:    'var(--r-card)',
        control: 'var(--r-control)',
        bubble:  'var(--r-bubble)',
      },
    },
  },
  plugins: [],
};
