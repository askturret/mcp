# Security Policy

Thank you for helping keep AskTurret MCP and its users safe. We take security vulnerabilities seriously and appreciate your efforts to responsibly disclose any issues you find.

---

## Supported Versions

We provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: Latest minor only |
| < 0.1   | :x:                |

**Note:** As a pre-1.0 project, we only support the latest minor version. Once we reach 1.0, we will maintain security updates for the current major version and the previous major version.

---

## Reporting a Vulnerability

**Please do NOT open public issues for security vulnerabilities.**

### Preferred Channel: GitHub Private Vulnerability Reporting

If you discover a security vulnerability in AskTurret MCP, please report it through [GitHub's private vulnerability reporting feature](https://github.com/askturret/mcp/security/advisories/new).

This ensures the issue is handled privately and allows us to coordinate a fix before public disclosure.

### Fallback: Email

If private vulnerability reporting is unavailable, please email:

**security@askturret.com**

---

## What to Include in Your Report

To help us understand and address the vulnerability quickly, please include:

1. **Description** — A clear description of the vulnerability
2. **Reproduction steps** — Detailed steps to reproduce the issue
3. **Affected versions** — Which versions of AskTurret MCP are affected
4. **Impact assessment** — Your assessment of the potential impact (e.g., data exposure, privilege escalation, denial of service)
5. **Suggested fix** — If you have ideas for how to fix the issue, please share them (optional but appreciated)
6. **Proof of concept** — Any code, configuration, or payloads that demonstrate the vulnerability (please use responsibly)

The more detail you provide, the faster we can validate and address the issue.

---

## Response Commitment

**Initial Acknowledgment:**  
We aim to acknowledge receipt of your vulnerability report within **2 business days**.

**Status Updates:**  
We will keep you informed of our progress as we investigate and develop a fix.

**Equal Treatment:**  
Security reports from community contributors receive the same priority and response times as those from commercial users or partners.

---

## Disclosure Policy

We follow a **coordinated disclosure** approach:

- **Default disclosure window:** 90 days from the initial report
- **Early disclosure:** If the vulnerability is being actively exploited in the wild, we may accelerate the disclosure timeline in coordination with you
- **Delayed disclosure:** If mitigating circumstances require more time (e.g., coordinating patches across multiple dependencies), we may request a reasonable extension

We will work with you to determine an appropriate disclosure date that protects users while giving credit to researchers.

Once a fix is released:
- We will publish a security advisory on GitHub
- We will credit you in the advisory (unless you prefer to remain anonymous)
- We will notify users through our release notes and relevant channels

---

## Scope

### In Scope

Security vulnerabilities in the following components are in scope for this policy:

- **Core runtime** (`@askturret/mcp-core`)
- **Official adapters** (Express, Fastify, etc.)
- **Official transports** (HTTP, stdio)
- **Official sources** (OpenAPI, schema-based)
- **CLI tools** (`doctor`, `inspect`, etc.)
- **Published npm packages** under the `@askturret` scope

### Out of Scope

The following are **not** covered by this security policy:

- **Adopter application code** — Vulnerabilities in applications built using AskTurret MCP are the responsibility of the application developer
- **Third-party dependencies** — Please report vulnerabilities in third-party packages directly to their maintainers
- **Self-hosted infrastructure** — Security of your own deployment infrastructure is your responsibility
- **Social engineering** — Attacks that rely on deceiving users rather than technical vulnerabilities

If you're unsure whether an issue is in scope, please reach out — we're happy to clarify.

---

## Safe Harbor

We believe security research makes the internet safer for everyone. **Good-faith security researchers who follow this policy will not face legal action** from AskTurret for their research activities.

"Good faith" means:

- You make a good-faith effort to avoid privacy violations, data destruction, and service interruption
- You do not exploit the vulnerability beyond what is necessary to demonstrate the issue
- You give us a reasonable time to fix the issue before public disclosure
- You do not access, modify, or exfiltrate data belonging to others without explicit permission

If you follow these guidelines, we will:
- Work with you to understand and validate the issue
- Acknowledge your contribution publicly (if desired)
- Not pursue legal action related to your research

---

## Bug Bounty Program

We do not currently offer a bug bounty program. However, we deeply value security research and may introduce a bounty program in the future as the project matures.

In the meantime, we will publicly credit researchers who responsibly disclose vulnerabilities (unless you prefer anonymity).

---

## Security Best Practices for Users

If you're deploying AskTurret MCP in production, we recommend:

1. **Keep dependencies up to date** — Regularly update to the latest versions to receive security patches
2. **Use the `production` preset** — The Light preset is for development; production environments should use stricter policies
3. **Enable authentication and authorization** — Do not expose MCP endpoints without proper access control
4. **Review policies carefully** — Ensure your operation-inclusion rules and effect classifications match your security requirements
5. **Monitor and audit** — Enable observability and audit logging to detect suspicious activity
6. **Follow the principle of least privilege** — Only expose the operations your agents actually need

See our [Policy Configuration Guide](docs/policies.md) for more details.

---

## Telemetry and Data Collection

**AskTurret MCP collects nothing.** There is no telemetry, no analytics and no
phone-home. The package makes no outbound network call unless you configure one
yourself — an executor, an adapter, or an exporter pointed at your own collector.

If usage telemetry is ever added it will be **opt-in only**, disabled by default,
and it will **never** collect tool arguments or responses, principal identifiers,
your API schemas, or response bodies — no opt-in enables those. A build that
transmits any of them is a security bug; please report it through the process
above.

The default is enforced by CI, not just documented: a guard fails the build if
any package source file imports a network-capable module outside the small
allowlist of files that exist to make calls on your behalf.

Full terms, including exactly what opt-in telemetry could ever collect and how to
inspect the payload before it is sent: [Telemetry Policy](docs/telemetry-policy.md).

---

## Contact

For security-related questions that are **not** vulnerability reports:

- **General security questions:** Open a [GitHub Discussion](https://github.com/askturret/mcp/discussions)
- **Commercial security inquiries:** Email security@askturret.com

For all other inquiries, see our [Contributing Guide](CONTRIBUTING.md).

---

Thank you for helping us keep AskTurret MCP secure!
