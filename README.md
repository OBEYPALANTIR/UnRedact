<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

People in power have betrayed us and only serve self interest. We deserve to live in a peaceful world. Our children deserve to be safe.

These monsters must be held accountable for their actions.

let's build tools to dismantle their control.

This application started as a project on my phone but expanded to Antigravity using Claude 4.6 Opus.

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/755aacd2-59b7-45c7-945f-f536014bc589

## Run Locally

**Prerequisites:** Node.js 22.13 or newer.


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

Open http://127.0.0.1:3000. The server binds only to loopback and accepts
same-origin local requests. The API key stays on the server and is never
injected into the browser bundle. Do not expose this local server through a
public proxy or tunnel; a hosted deployment needs authentication and per-user
usage limits.

Set `GEMINI_MODEL` on the server to choose a model available to your account.
The default is `gemini-3.6-flash`, the replacement listed by Google for the
retired preview previously used here:
[Gemini model deprecations](https://ai.google.dev/gemini-api/docs/deprecations).
Live model access and billing depend on your account.

Analysis accepts PDFs up to 20 MB, permits one request at a time and ten per
minute, and caps each response at 8,192 tokens. Run `npm run build` followed by
`npm run preview` for the local production build.

Run `npm test`, `npm run lint`, and `npm run build` to validate changes.
