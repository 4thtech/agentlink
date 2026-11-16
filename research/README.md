# AgentLink research

Articles, essays and research papers about **agent-to-agent communication**: encrypted exchange between AI agents, provable agreements, owner approval for agents that act in our name, and AgentLink itself — what it is, why it was built and what we learn while building it in public.

The product documentation lives in [`docs-site/`](../docs-site/README.md) (also on [4thTech Docs](https://wiki.4thtech.io/products/agentlink)) and the specifications in [`docs/foundation/`](../docs/foundation/00-README.md). This section is different: it holds signed, dated pieces with an argument and a point of view. Each one links back to the docs and specs, so it also works as a gateway for readers who want to go deeper.

## Published

| Title | Author | Date | Type | Summary |
| --- | --- | --- | --- | --- |
| [Stop Playing Postman: Why I Built AgentLink, a Private Line Between AI Agents](articles/stop-playing-postman/index.md) | Tali Režun | 15 Nov 2026 | Article | From the first on-chain message in 2016 to AgentLink 0.5.8: the idea, the thesis, how messages, files and proofs work, the architecture, and how it was built with an orchestrated team of AI agents. |

## Contribute a piece

We would love to publish your work here. If you think about how AI agents should talk to each other, how they can prove what was agreed, how humans stay in charge, or you have built something with AgentLink, there is a place for you in this section. First-time writers are welcome; we help with editing.

- **Discuss an idea:** open an [issue](https://github.com/4thtech/agentlink/issues) with a short proposal (title, outline, why it matters).
- **Comment on a piece:** open an issue that names the article, or send a pull request with a correction.
- **Write it:** follow the [contributing guide](CONTRIBUTING.md) and start from the [article template](articles/_template/index.md).

## Layout

```text
research/
├─ README.md               # this page: what the section is and the index
├─ CONTRIBUTING.md         # what we accept and how a piece gets published
└─ articles/
   ├─ _template/index.md   # copy this folder to articles/<slug>/ to start a piece
   └─ <slug>/              # one folder per piece, slug in lowercase-with-dashes
      ├─ index.md          # the text, with front matter
      └─ images/           # figures and screenshots used by index.md
```

## Citation

Cite a piece by author, title, year and its URL in this repository, for example:

```bibtex
@article{rezun2026stopplayingpostman,
  author = {Režun, Tali},
  title  = {Stop Playing Postman: Why I Built AgentLink, a Private Line Between AI Agents},
  year   = {2026},
  month  = {November},
  url    = {https://github.com/4thtech/agentlink/blob/main/research/articles/stop-playing-postman/index.md}
}
```

## Related

- [Project README](../README.md): status and roadmap
- [User guide](../docs-site/guide/README.md) and [technical docs](../docs-site/technical/README.md)
- [Knowledge files for AI assistants](../knowledge/README.md)
- [Contributing to AgentLink](../CONTRIBUTING.md) (code and docs)
