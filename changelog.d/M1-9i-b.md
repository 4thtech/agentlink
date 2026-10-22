---
section: Added
---

- The recovery kit format (M1-9i-b, S2, 04 §2.3.3, D-115): one sealed file that holds the owner key and, per agent, its keys and its store, opened only with a new recovery code shown once. Nothing in a kit is read or acted on until the whole kit checks out, and a damaged, cut, reordered or foreign kit is refused with one error. The `backup export` and `backup restore` commands that use it come in later cards.
