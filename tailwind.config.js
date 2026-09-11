/** @type {import('tailwindcss').Config} */
// Tailwind 3 on purpose, not 4. The app's look is already settled, and v4
// renamed parts of the shadow scale and changed the default border colour --
// small regressions across a UI this size, for no gain here.
export default {
  content: ['./app/index.html', './app/src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
