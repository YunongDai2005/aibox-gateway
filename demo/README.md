# Reproducible single-chat demo

Run `npm run demo:record` from the repository root, then open `docs/demo/index.html`. Node.js 22+ is sufficient; recording does not require real accounts or external model access.

## Evidence

`record.mjs` starts the existing test harness with the actual v2 gateway. Seven synthetic messages create three topic sessions, revisit each, and add a follow-up. Assertions verify distinct session IDs and exact reuse of the original worker session IDs. Public trace IDs are normalized to S1/S2/S3.

The topic judge returns deterministic fixture decisions. DSH is a fake worker; it does not build a website, research batteries, or edit Python files. Therefore this replay is not evidence of semantic routing accuracy, real-provider compatibility, or task completion. Messages execute sequentially.

The advisor scene is a separate replay of the selection functions taken directly from `bin/helper.mjs`. An isolated VM supplies fake filesystem reads, synthetic quota data, and a fake Manager response. It never runs the helper CLI or real agents. Assertions check that a provider below 10% remaining is excluded, that quotas reach the Manager, and that the selected candidate is returned. Task fit is a scripted Manager decision, not a benchmark result.

`build.mjs` embeds the verified trace into `viewer.template.html`, creating a standalone viewer. Playback timing and explanatory captions are presentation choices. `trace.json` is the inspectable evidence; it contains only synthetic data.

## Files

- `record.mjs`: gateway and advisor-policy replay with assertions.
- `build.mjs`: standalone viewer builder.
- `viewer.template.html`: viewer source.
- `../docs/demo/trace.json`: generated, normalized replay evidence.
- `../docs/demo/index.html`: generated interactive viewer.
- `../docs/demo/preview.gif`: visual preview of the eight scenes.

The replay intentionally does not claim a universal Manager entry point, task-bound mailbox delivery, or independent concurrent topic execution. Those remain roadmap work.
