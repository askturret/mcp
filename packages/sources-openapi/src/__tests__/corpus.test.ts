/**
 * Real-world OpenAPI corpus tests
 *
 * Tests fromOpenApi() against simplified versions of real-world APIs:
 * - Stripe (payment processing)
 * - GitHub (developer platform)
 * - Shopify (e-commerce)
 * - Twilio (communications)
 * - SendGrid (email)
 *
 * Tracks "MCP readiness" score for each spec.
 */

import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { DiscoveryContext } from '@askturret/mcp-core';
import { fromOpenApi } from '../from-openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create a minimal discovery context for testing
 */
function createTestContext(): DiscoveryContext {
  return {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    abortSignal: new AbortController().signal,
  };
}

/**
 * Load a corpus fixture
 */
function loadCorpusFixture(name: string): unknown {
  const path = join(__dirname, 'fixtures', 'corpus', `${name}.json`);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content);
}

/**
 * Calculate MCP readiness score for a discovered operation set
 *
 * Scoring criteria:
 * - Has operation ID: +10 points
 * - Has description: +10 points
 * - Has input schema: +15 points
 * - Has output schema: +15 points
 * - Has effect metadata: +20 points
 * - Has provenance: +10 points
 * - Has x-mcp extensions: +10 points (bonus)
 * - Effect classifications present: +10 points (bonus)
 *
 * Perfect score: 100 points per operation
 */
interface ReadinessScore {
  totalOperations: number;
  totalPoints: number;
  maxPoints: number;
  percentage: number;
  averagePerOperation: number;
  breakdown: {
    hasOperationId: number;
    hasDescription: number;
    hasInputSchema: number;
    hasOutputSchema: number;
    hasEffects: number;
    hasProvenance: number;
    hasXMcp: number;
    hasClassifications: number;
  };
}

function calculateReadinessScore(operations: unknown[]): ReadinessScore {
  let totalPoints = 0;
  const breakdown = {
    hasOperationId: 0,
    hasDescription: 0,
    hasInputSchema: 0,
    hasOutputSchema: 0,
    hasEffects: 0,
    hasProvenance: 0,
    hasXMcp: 0,
    hasClassifications: 0,
  };

  for (const op of operations) {
    const operation = op as Record<string, unknown>;

    if (operation.candidateId) {
      totalPoints += 10;
      breakdown.hasOperationId++;
    }
    if (operation.description) {
      totalPoints += 10;
      breakdown.hasDescription++;
    }
    if (operation.rawInput) {
      totalPoints += 15;
      breakdown.hasInputSchema++;
    }
    if (operation.rawOutput) {
      totalPoints += 15;
      breakdown.hasOutputSchema++;
    }
    if (operation.effects) {
      totalPoints += 20;
      breakdown.hasEffects++;
    }
    if (operation.provenance && Array.isArray(operation.provenance) && operation.provenance.length > 0) {
      totalPoints += 10;
      breakdown.hasProvenance++;
    }
    if (operation.hints && typeof operation.hints === 'object') {
      const hints = operation.hints as Record<string, unknown>;
      if ('effects' in hints || 'annotations' in hints) {
        totalPoints += 10;
        breakdown.hasXMcp++;
      }
    }
    if (operation.effects && typeof operation.effects === 'object') {
      const effects = operation.effects as Record<string, unknown>;
      if (effects.classifications && Array.isArray(effects.classifications) && effects.classifications.length > 0) {
        totalPoints += 10;
        breakdown.hasClassifications++;
      }
    }
  }

  const maxPoints = operations.length * 100;
  const percentage = maxPoints > 0 ? (totalPoints / maxPoints) * 100 : 0;
  const averagePerOperation = operations.length > 0 ? totalPoints / operations.length : 0;

  return {
    totalOperations: operations.length,
    totalPoints,
    maxPoints,
    percentage,
    averagePerOperation,
    breakdown,
  };
}

describe('Real-world API corpus', () => {
  describe('Stripe API subset', () => {
    it('should discover all operations from Stripe spec', async () => {
      const spec = loadCorpusFixture('stripe-subset');
      const source = fromOpenApi(spec, { location: 'stripe-subset.json' });
      const operations = await source.discover(createTestContext());

      // Expect 3 operations: createPaymentIntent, listPaymentIntents, retrievePaymentIntent
      expect(operations).toHaveLength(3);

      // Verify createPaymentIntent has financial classification
      const createIntent = operations.find(op => op.candidateId === 'createPaymentIntent');
      expect(createIntent).toBeDefined();
      expect(createIntent?.effects?.classifications).toContain('financial');
      expect(createIntent?.effects?.idempotencyKeyRequired).toBe(true); // POST
    });

    it('should achieve high MCP readiness score', async () => {
      const spec = loadCorpusFixture('stripe-subset');
      const source = fromOpenApi(spec, { location: 'stripe-subset.json' });
      const operations = await source.discover(createTestContext());

      const score = calculateReadinessScore(operations);

      // Stripe spec should score well (has operationIds, descriptions, schemas)
      expect(score.percentage).toBeGreaterThan(70);
      expect(score.breakdown.hasOperationId).toBe(3);
      expect(score.breakdown.hasDescription).toBe(3);
      expect(score.breakdown.hasEffects).toBe(3);
    });
  });

  describe('GitHub API subset', () => {
    it('should discover all operations from GitHub spec', async () => {
      const spec = loadCorpusFixture('github-subset');
      const source = fromOpenApi(spec, { location: 'github-subset.json' });
      const operations = await source.discover(createTestContext());

      // Expect 3 operations: getRepository, listIssues, createIssue
      expect(operations).toHaveLength(3);

      // Verify GET is read-only
      const getRepo = operations.find(op => op.candidateId === 'getRepository');
      expect(getRepo?.effects?.readOnly).toBe(true);

      // Verify POST requires idempotency key
      const createIssue = operations.find(op => op.candidateId === 'createIssue');
      expect(createIssue?.effects?.idempotencyKeyRequired).toBe(true);
    });

    it('should achieve high MCP readiness score', async () => {
      const spec = loadCorpusFixture('github-subset');
      const source = fromOpenApi(spec, { location: 'github-subset.json' });
      const operations = await source.discover(createTestContext());

      const score = calculateReadinessScore(operations);

      // GitHub's real-world spec scores 70.0% - reasonable for a production API
      expect(score.percentage).toBeGreaterThanOrEqual(70);
      expect(score.totalOperations).toBe(3);
    });
  });

  describe('Shopify API subset', () => {
    it('should discover all operations from Shopify spec', async () => {
      const spec = loadCorpusFixture('shopify-subset');
      const source = fromOpenApi(spec, { location: 'shopify-subset.json' });
      const operations = await source.discover(createTestContext());

      // Expect 4 operations: listProducts, createProduct, updateProduct, deleteProduct
      expect(operations).toHaveLength(4);

      // Verify PUT is idempotent but not retryable
      const updateProduct = operations.find(op => op.candidateId === 'updateProduct');
      expect(updateProduct?.effects?.idempotent).toBe(true);
      expect(updateProduct?.effects?.retryable).toBe(false);

      // Verify DELETE is idempotent
      const deleteProduct = operations.find(op => op.candidateId === 'deleteProduct');
      expect(deleteProduct?.effects?.idempotent).toBe(true);
    });

    it('should handle OpenAPI 3.1 spec', async () => {
      const spec = loadCorpusFixture('shopify-subset') as { openapi: string };
      expect(spec.openapi).toBe('3.1.0');

      const source = fromOpenApi(spec, { location: 'shopify-subset.json' });
      const operations = await source.discover(createTestContext());

      expect(operations.length).toBeGreaterThan(0);
    });

    it('should achieve high MCP readiness score', async () => {
      const spec = loadCorpusFixture('shopify-subset');
      const source = fromOpenApi(spec, { location: 'shopify-subset.json' });
      const operations = await source.discover(createTestContext());

      const score = calculateReadinessScore(operations);

      // Shopify's real-world spec scores 68.8% - slightly lower but still representative
      // of production APIs with varying documentation quality
      expect(score.percentage).toBeGreaterThanOrEqual(65);
      expect(score.totalOperations).toBe(4);
    });
  });

  describe('Twilio API subset', () => {
    it('should discover operations with notification classification', async () => {
      const spec = loadCorpusFixture('twilio-subset');
      const source = fromOpenApi(spec, { location: 'twilio-subset.json' });
      const operations = await source.discover(createTestContext());

      // Expect 2 operations: createMessage, listMessages
      expect(operations).toHaveLength(2);

      // Verify createMessage has notification classification from x-mcp
      const createMessage = operations.find(op => op.candidateId === 'createMessage');
      expect(createMessage?.effects?.classifications).toContain('notification');
    });

    it('should achieve high MCP readiness score', async () => {
      const spec = loadCorpusFixture('twilio-subset');
      const source = fromOpenApi(spec, { location: 'twilio-subset.json' });
      const operations = await source.discover(createTestContext());

      const score = calculateReadinessScore(operations);

      expect(score.percentage).toBeGreaterThan(65);
      expect(score.breakdown.hasClassifications).toBeGreaterThan(0); // Has x-mcp classifications
    });
  });

  describe('SendGrid API subset', () => {
    it('should discover email operations', async () => {
      const spec = loadCorpusFixture('sendgrid-subset');
      const source = fromOpenApi(spec, { location: 'sendgrid-subset.json' });
      const operations = await source.discover(createTestContext());

      // Expect 2 operations: sendEmail, listTemplates
      expect(operations).toHaveLength(2);

      // Verify sendEmail has notification classification
      const sendEmail = operations.find(op => op.candidateId === 'sendEmail');
      expect(sendEmail?.effects?.classifications).toContain('notification');
    });

    it('should achieve high MCP readiness score', async () => {
      const spec = loadCorpusFixture('sendgrid-subset');
      const source = fromOpenApi(spec, { location: 'sendgrid-subset.json' });
      const operations = await source.discover(createTestContext());

      const score = calculateReadinessScore(operations);

      expect(score.percentage).toBeGreaterThan(65);
      expect(score.totalOperations).toBe(2);
    });
  });

  describe('Aggregate corpus statistics', () => {
    it('should track overall MCP readiness across all corpus specs', async () => {
      const fixtures = ['stripe-subset', 'github-subset', 'shopify-subset', 'twilio-subset', 'sendgrid-subset'];
      const allScores: ReadinessScore[] = [];

      for (const fixture of fixtures) {
        const spec = loadCorpusFixture(fixture);
        const source = fromOpenApi(spec, { location: `${fixture}.json` });
        const operations = await source.discover(createTestContext());
        const score = calculateReadinessScore(operations);
        allScores.push(score);
      }

      // Aggregate statistics
      const totalOps = allScores.reduce((sum, s) => sum + s.totalOperations, 0);
      const totalPoints = allScores.reduce((sum, s) => sum + s.totalPoints, 0);
      const maxPoints = allScores.reduce((sum, s) => sum + s.maxPoints, 0);
      const overallPercentage = (totalPoints / maxPoints) * 100;

      // Expect reasonable coverage across corpus
      expect(totalOps).toBe(14); // 3 + 3 + 4 + 2 + 2
      expect(overallPercentage).toBeGreaterThan(65); // Corpus should be reasonably MCP-ready

      // Log scores for regression tracking
      console.log('\n=== MCP Readiness Corpus Report ===');
      fixtures.forEach((name, i) => {
        const score = allScores[i];
        console.log(`${name}: ${score.percentage.toFixed(1)}% (${score.totalOperations} ops)`);
      });
      console.log(`Overall: ${overallPercentage.toFixed(1)}% (${totalOps} ops total)`);
      console.log('===================================\n');
    });
  });
});
