# Social Preview Image Specification

This file specifies the social preview image to be configured for the AskTurret MCP GitHub repository.

## Image Specifications

**Filename:** `social-preview.png`  
**Location:** `static/social-preview.png` (or repo root for GitHub to detect)  
**Format:** PNG (lossless)  
**Dimensions:** 1280 × 640 pixels  
**Color space:** sRGB  

## Design Guidelines

The social preview image appears when someone shares the repository link on Twitter/X, LinkedIn, Slack, Discord, etc. It should:

### 1. Lead with the Value Proposition
- **Primary text:** "Add MCP to your API"
- **Secondary text:** "Production-grade API-to-agent layer"
- Large, readable typography that works at thumbnail size

### 2. Visual Hierarchy
```
┌─────────────────────────────────────────────────┐
│                                                 │
│  [Logo] AskTurret MCP                          │
│                                                 │
│  Add a production-grade MCP layer               │
│  to your existing API                           │
│                                                 │
│  askturret.com                                  │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 3. Visual Elements
- **Logo:** AskTurret logo (if available) or "MCP" badge
- **Diagram:** Simple arrow showing "API → MCP layer → Agents" flow
- **Color scheme:** 
  - Primary: Professional tech color (blue #0066CC or similar)
  - Accent: Green for "ready/go" (#22C55E or similar)
  - Background: Clean white or light gray
- **Spacing:** Generous padding. Text should not touch edges.

### 4. Readability Checklist
- [ ] Logo/text visible at 200px wide (Twitter card size)
- [ ] No text thinner than 400 weight (regular)
- [ ] Contrast ratio ≥ 4.5:1 for all text
- [ ] No busy gradients or patterns
- [ ] Consistent with brand (if brand guide exists)

### 5. Content Copy Options

**Option A (Technical):**
```
Add MCP to your API

Discover. Shape. Govern. Serve. Observe.
```

**Option B (Benefit-driven):**
```
Production-grade MCP for your API

Ship agent access safely in minutes.
```

**Option C (Comparison):**
```
MCP Runtime, Not Generator

Policies. Overlays. No regeneration.
```

## Recommended Design Tools

- **Figma:** Professional, collaborative
- **Photoshop:** Full control
- **Canva:** Quick (AskTurret may already have a Canva team account)
- **Sketch:** Mac-native option

## Implementation

Once the image is ready:

1. **Save to:** `static/social-preview.png` (GitHub will auto-detect from `static/` folder) or root directory
2. **GitHub Settings:**
   - Go to repository Settings → General
   - Scroll to "Social preview"
   - Upload image or GitHub will auto-detect from root directory
3. **Test:**
   - Share repo URL on Twitter/X, paste into card generator (Twitter's card validator)
   - Check preview on LinkedIn share
   - Verify in Slack's unfurl preview

## Examples of Well-Done Social Preview Images

- [Supabase](https://github.com/supabase/supabase) - Clean, on-brand, clear value prop
- [Vercel](https://github.com/vercel/next.js) - Minimal, logo-forward, recognizable
- [Remix](https://github.com/remix-run/remix) - Color-coordinated, distinctive

## Checklist

- [ ] Image created to spec (1280×640 PNG)
- [ ] Logo visible and recognizable
- [ ] Value proposition clear at thumbnail size
- [ ] High contrast text
- [ ] Tested in Twitter Card Validator
- [ ] Tested in LinkedIn share preview
- [ ] Saved to repo (suggest `static/social-preview.png`)
- [ ] GitHub Settings → Social preview configured
- [ ] Shared links show preview in Slack/Discord
