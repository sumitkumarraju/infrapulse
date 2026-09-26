# InfraPulse

Predictive road-condition monitoring for the network around Chandigarh
University, Gharuan. Every phone that drives a road is a sensor: bumps become a
condition score for each 50-metre segment, the score is projected 90 days
forward, and repairs are ranked by the risk they remove per rupee.

Frontend only — all data comes from a deterministic mock layer that behaves like
the real system, including a live event stream.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Putting it on GitHub

The repository is committed and clean: `.env` is ignored, and a scan of every
tracked file finds no keys, tokens or connection strings.

```bash
gh repo create infrapulse --private --source=. --push
```

Or without the `gh` CLI — create an empty repository on GitHub first, then:

```bash
git remote add origin https://github.com/<your-account>/infrapulse.git
git push -u origin main
```

Git Credential Manager is already installed on this machine and will prompt in
a browser window. It currently holds `mrrkr`, so pushing as a different account
means signing in as that account when it asks.

**Add files with `git add`, never through GitHub's web uploader.** That
interface does not consult `.gitignore` — it commits whatever is dragged into
it, which is how a live service-account key reached a public repository twice.

- `CLAUDE.md` — how the app is built, and what is still missing.
- `UI_DESIGN.md` — the visual specification: colour, type, the 3D map, every
  screen, motion, accessibility.
