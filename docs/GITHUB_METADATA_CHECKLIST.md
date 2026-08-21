# GitHub Repository Metadata Checklist

This checklist ensures the AskTurret MCP repository is discoverable and well-configured for GitHub, npm, and search engines.

## Repository Settings Configuration

**Path:** Repository Settings → General → About section

### Short Description
```
Production-grade MCP layer for existing APIs. Discover from OpenAPI, shape agent-friendly tools, govern access, observe every call.
```

**Character count:** ~140 characters (displays in search results)  
**Note:** Matches the supporting line from positioning.md

### Homepage URL
Once documentation is live:
```
https://docs.askturret.com
```
(or your current docs site URL)

### Repository Topics
```
mcp
model-context-protocol
openapi
api-management
agent-tools
ai-agents
llm-tools
typescript
nodejs
express
fastify
api-governance
observability
opentelemetry
```

**Guidelines:**
- Aim for 15-20 topics (GitHub recommends ≤30)
- Cover all four intersection categories from §18.1:
  1. API management and OpenAPI tooling
  2. MCP server frameworks
  3. OpenAPI-to-MCP generators (to capture relevant searches)
  4. Agent security and governance

**Topic breakdown by category:**

| Category | Topics |
|----------|--------|
| **MCP Protocol** | `mcp`, `model-context-protocol` |
| **API & OpenAPI** | `openapi`, `api-management`, `api-gateway` |
| **AI & Agents** | `agent-tools`, `ai-agents`, `llm-tools` |
| **Tech Stack** | `typescript`, `nodejs`, `express`, `fastify` |
| **Operations** | `api-governance`, `observability`, `opentelemetry` |

### License
Check: LICENSE file is present and detected by GitHub

**Current:** Apache 2.0 (in LICENSE file)

### Include in GitHub's public archive
✅ Enable (helps archivists preserve open-source projects)

## npm Package Configuration (package.json)

If publishing to npm as `@askturret/mcp`:

```json
{
  "name": "@askturret/mcp",
  "version": "0.1.0",
  "description": "Production-grade MCP layer for existing APIs. Discover from OpenAPI, shape agent-friendly tools, govern access, observe every call.",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "openapi",
    "agents",
    "api",
    "typescript"
  ],
  "homepage": "https://github.com/askturret/mcp",
  "repository": {
    "type": "git",
    "url": "https://github.com/askturret/mcp.git"
  },
  "bugs": {
    "url": "https://github.com/askturret/mcp/issues"
  },
  "license": "Apache-2.0",
  "author": "AskTurret",
  "engines": {
    "node": ">=18"
  }
}
```

## Social Preview Image

**File:** `static/social-preview.png` (or auto-detect from root)  
**Dimensions:** 1280 × 640 pixels  
**Format:** PNG  

**GitHub Settings:** Settings → General → Social preview  
(GitHub auto-detects from `social-preview.png` in repo root or `static/` folder)

## Community Profile (GitHub's report card)

**Path:** Settings → General → Community section (GitHub generates this from existing files)

### Required Files for 100% Community Score

- ✅ **README.md** — Already in place
- ⬜ **CONTRIBUTING.md** — Create with contributor guidelines
- ⬜ **SECURITY.md** — Security reporting policy
- ⬜ **CODE_OF_CONDUCT.md** — Community guidelines
- ⬜ **LICENSE** — Apache 2.0 (already in place)
- ⬜ **Discussions enabled** — Optional but recommended
- ⬜ **Issue templates** — Optional
- ⬜ **Pull request template** — Optional

**Template content suggestions:**

#### CONTRIBUTING.md
```markdown
# Contributing to AskTurret MCP

We welcome contributions! Here's how you can help:

1. **Report bugs** — Use GitHub Issues
2. **Suggest features** — Use GitHub Discussions
3. **Submit pull requests** — See below

## Getting Started

- Fork the repository
- Install: `npm install`
- Build: `npm run build`
- Test: `npm test`
- Open a PR with a clear description

## Code of Conduct

This project adheres to the Contributor Covenant [Code of Conduct](CODE_OF_CONDUCT.md).
All contributors must follow these guidelines.

## Good First Issues

Look for issues tagged with `good first issue` or `help wanted`.
```

#### SECURITY.md
```markdown
# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, **please do not open a public issue**.

Instead, email security@askturret.com with:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- (Optional) Suggested fix

We will respond within 48 hours and work with you on a coordinated disclosure.

## Supported Versions

- Latest version: Receives all security updates
- Previous minor version: Receives critical updates
- Older versions: No official support
```

#### CODE_OF_CONDUCT.md
```markdown
# Contributor Covenant Code of Conduct

## Our Pledge

We are committed to providing a welcoming and inspiring community for all.

## Expected Behavior

- Be respectful and inclusive
- Welcome diverse perspectives
- Give and receive feedback gracefully
- Focus on constructive dialogue

## Enforcement

Violations should be reported to conduct@askturret.com. We will investigate and respond appropriately.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant](https://www.contributor-covenant.org/).
```

## Badges

Add to README.md (already included):

```markdown
[![npm version](https://img.shields.io/npm/v/@askturret/mcp.svg?style=flat-square)](https://www.npmjs.com/package/@askturret/mcp)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0%2B-blue?style=flat-square)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)
```

## Search Engine Optimization

- **Repository description:** Clear, includes keywords ✅
- **Topics:** 15-20 relevant tags ✅
- **License:** Apache 2.0 (reputable) ✅
- **README:** Well-structured with sections ✅
- **Links:** to docs, contributing, security ✅

## Checklist

### GitHub Settings
- [ ] Short description updated
- [ ] Homepage URL set
- [ ] Topics added (15-20)
- [ ] License visible (Apache 2.0)
- [ ] Social preview image configured
- [ ] Community profile files created

### npm (if applicable)
- [ ] package.json description updated
- [ ] Repository URL specified
- [ ] License specified
- [ ] Keywords added
- [ ] Engine requirements set (Node.js 18+)

### Community Files
- [ ] CONTRIBUTING.md created
- [ ] SECURITY.md created
- [ ] CODE_OF_CONDUCT.md created
- [ ] Badges added to README

### Search & Discovery
- [ ] Topics match market definition (§18.1)
- [ ] Description mentions all key differentiators
- [ ] Keywords include both users and competitors
- [ ] Links to docs and roadmap present

## Testing Discovery

After configuration:

1. **GitHub search:** Search for "mcp openapi" and verify repo appears
2. **npm search:** Search for "mcp" on npm.org and verify package
3. **Twitter card:** Paste repo URL into Twitter Card Validator
4. **Slack unfurl:** Share repo link in Slack and verify preview
5. **Google:** Search "askturret mcp" and check if repo ranks

## References

- [GitHub topic descriptions](https://github.com/topics)
- [Shields.io badge generator](https://shields.io/)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)
