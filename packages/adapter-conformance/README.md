# @askturret/mcp-adapter-conformance

The conformance **contract** for AskTurret framework adapters: the shared bank of
behaviours every adapter must exhibit, expressed as runnable cases rather than as
prose.

This package holds the bank. It does not run it for you — that is
[`@askturret/mcp-adapter-test`](https://www.npmjs.com/package/@askturret/mcp-adapter-test),
which loads your adapter and executes everything here against it. You want this
package directly only if you are building tooling around the bank itself.

## What a contract buys you

An adapter is a small amount of code in an awkward position: it sits between a
framework's request lifecycle and the MCP protocol, and most of its interesting
behaviour is about failure — a cancelled request, a body larger than the cap, a
handler that throws after the response has begun.

Those are the cases nobody writes tests for twice. The bank writes them once, so
an adapter for a framework nobody has integrated yet inherits the same scrutiny
the official ones get.

## Installing

```bash
npm install --save-dev @askturret/mcp-adapter-conformance
```

```js
import { CATEGORIES, runBank } from '@askturret/mcp-adapter-conformance';
```

`CATEGORIES` is the category list the bank is partitioned into; `runBank` drives
an adapter through them. Importing the module also registers the in-repo
adapters, so you get a populated registry rather than an empty one that silently
tests nothing.

## The same path for everyone

The two official adapters — Express and Fastify — are measured through the
**same public `AdapterUnderTest` shape** a community adapter uses. That is a
deliberate constraint rather than an accident of layout: if the official
adapters were measured through a privileged internal path, their result would
not mean what yours means, and the published comparison table would be putting
two different measurements in the same column.

## Versioning

This package's version tracks the project. The **conformance-result contract**
is versioned separately as `KIT_VERSION`, exported from
[`@askturret/mcp-adapter-test`](https://www.npmjs.com/package/@askturret/mcp-adapter-test)
— it moves when a category changes or an existing one gets stricter, so a stored
result stays meaningful alongside the kit that produced it.

## Licence

Apache-2.0. See the LICENSE and NOTICE files inside this package.
