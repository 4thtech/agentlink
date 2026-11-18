# Contributing to AgentLink research

Thank you for considering a piece for this section. This page says what we accept, how a piece is laid out and how it gets published. For code and docs contributions, see the main [CONTRIBUTING.md](../CONTRIBUTING.md).

## What we accept

- **Articles and essays** on agent-to-agent communication, encrypted exchange between AI agents, identity and trust between agents, owner approval and human oversight, provable agreements, and agent commerce.
- **Research papers and design studies**, including measurements, threat analyses and comparisons with other approaches.
- **Field reports** from using or building on AgentLink: what worked, what broke, what you learned.

A piece should have something to say: an argument, a finding or an experience. Product documentation belongs in [`docs/`](../docs/README.md), and changes to the protocol belong in the [specifications](../specs/00-README.md) through their own process.

## Process

1. **Propose.** Open an [issue](https://github.com/4thtech/agentlink/issues) with a title, a short outline and who it is for. We reply on scope and fit before you invest a lot of time.
2. **Write.** Copy the [template folder](articles/_template/index.md) to `research/articles/<slug>/` and put your images in `research/articles/<slug>/images/`.
3. **Open a pull request** with the title `DOCS: research, <short title>`. Add a row for your piece to the index in [`README.md`](README.md).
4. **Review.** A maintainer reviews the piece in the pull request: factual accuracy against the current release, links, clarity and fit. We may suggest edits, but the voice and the argument stay yours. Opinions are welcome; claims about what AgentLink does must be true for the current release.
5. **Publish.** Once approved, the pull request merges and the piece is live. Corrections later go through a pull request too; a substantial change adds an `updated` date to the front matter.

## Layout of a piece

One folder per piece under `research/articles/`, named with a short slug in lowercase with dashes (`stop-playing-postman`):

- `index.md`: the text, starting with the front matter below.
- `images/`: every image the piece uses, with plain file names (lowercase, dashes, no spaces), referenced relatively (`images/architecture.png`). Keep each image under about 1 MB; prefer JPEG for photos and art, PNG for screenshots and diagrams. Every image needs alt text.

## Front matter

```yaml
---
title: 'The full title'
author: Your Name # several authors: [Name One, Name Two]
date: 2026-11-15 # first publication, YYYY-MM-DD
summary: One or two sentences that say what the piece argues or shows.
tags: [agent-to-agent, encryption]
status: published # draft | published | superseded
release: 0.5.8 # optional: the AgentLink release the piece describes
license: CC-BY-4.0
updated: # optional: date of a substantial later change
---
```

## Citations and links

- **Cite your sources.** Link to the original for every external fact, quote or figure, and list them in a "Sources & further reading" section at the end.
- **Link into the project.** When you mention an AgentLink concept, link to the page that explains it: the [user guide](../docs/guide/README.md) for how to use it, the [technical docs](../docs/technical/README.md) or the [specifications](../specs/00-README.md) for how it works. Use relative links for files in this repository so they keep working in forks and checkouts.
- **Date your claims.** AgentLink changes quickly. Say which release you describe (the `release` field), and mark planned features as planned.
- **Say how you know.** When you report numbers or results, say how they were measured and how big the sample was.

## Originality and licence

- Submit only work you wrote or have the right to publish. A piece that first appeared elsewhere is welcome if you hold the rights; say where it first appeared.
- Use plain words and the project's vocabulary: an "ID", an "agreement", a "proof" (see [Vocabulary and microcopy](../specs/11-claude-design-brief.md), section 5). Quoting a term in order to explain or reject it is fine.
- Never include secrets, keys, invite links, personal data of other people without their consent, or details of a security problem that is not fixed yet (report those privately, see [SECURITY.md](../SECURITY.md)).
- Text and images in `research/` are licensed under [CC BY 4.0](LICENSE) unless an article says otherwise; code snippets stay MIT, like the rest of the repository ([LICENSE](../LICENSE)). By contributing a piece, you agree to license it under CC BY 4.0, and you remain its author. Set `license: CC-BY-4.0` in the front matter.
