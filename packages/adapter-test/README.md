# @askturret/mcp-adapter-test

Run the AskTurret adapter conformance bank against **your** adapter, and get
back a result you can publish.

```bash
npx @askturret/mcp-adapter-test ./my-adapter
```

## What you write

One module, default-exporting an `AdapterUnderTest`:

```js
export default {
  name: 'my-adapter',
  async createServer(config) {
    // config is McpFacadeOptions — sources, executor, policies
    // return { url, close } once your server is listening
  },
};
```

Everything else is the kit's problem: it stands your server up, drives the
shared bank at it, tears it down, and reports per category.

## What you get back

```bash
npx @askturret/mcp-adapter-test ./my-adapter --json --out results.json
npx @askturret/mcp-adapter-test ./my-adapter --category cancellation
npx @askturret/mcp-adapter-test ./my-adapter --generate-badge conformance.svg
```

`--json` is a **public contract**, not a debug dump: it is the shape the
conformance table is generated from, so a result produced today stays readable
by tooling written later.

## Two versions, and they answer different questions

- **`version`** — this npm package's semver, tracking the project like any other
  workspace.
- **`KIT_VERSION`** — the **conformance-result contract**. It moves when the
  categories change or an existing one gets stricter, and *never* merely because
  a release happened.

That separation is the point. A stored result is only meaningful alongside the
kit version that produced it, and tying the contract to the release number would
have made every release look like a change to what conformance means.

## Where the cases live

The bank itself is
[`@askturret/mcp-adapter-conformance`](https://www.npmjs.com/package/@askturret/mcp-adapter-conformance),
a runtime dependency of this package. You do not need to install it yourself.

## Licence

Apache-2.0. See the LICENSE and NOTICE files inside this package.
