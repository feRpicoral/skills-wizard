import { z } from 'zod';

import type { EvalCase } from './cases.ts';
import type { GradedExpectation } from './grade.ts';
import { collapseWhitespace } from './report.ts';

const MALFORMED_GRADER_OUTPUT = 'Malformed grader output';

export const GRADER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          assertion: { type: 'string' },
          passed: { type: 'boolean' },
          evidence: { type: 'string' },
          quote: { type: 'string' },
        },
        // Strict structured-output modes need every property listed; an empty
        // quote means the grader had nothing to quote.
        required: ['assertion', 'passed', 'evidence', 'quote'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

export interface BuildBlindGraderPromptParams {
  evalCase: EvalCase;
  response: string;
  workspaceSummary: readonly string[];
  stringAssertions: readonly string[];
}

export function buildBlindGraderPrompt({
  evalCase,
  response,
  workspaceSummary,
  stringAssertions,
}: BuildBlindGraderPromptParams): string {
  return [
    'You are an impartial, blind evaluation grader.',
    'Evaluate each assertion against the task prompt, expected output description, agent response, and workspace files.',
    'Do not call any tools, read files, or run commands; grade strictly from the <agent_response> and <workspace_files> provided below and return the structured JSON output immediately.',
    'An assertion passes ONLY if there is clear, concrete evidence in the response or workspace files.',
    'Always provide a specific, non-empty evidence string explaining why each assertion passed or failed.',
    '',
    'Output format: a single JSON object {"results": [{"assertion": string, "passed": boolean, "evidence": string, "quote": string}]}.',
    '- Return exactly one result per assertion, in the order the assertions are listed.',
    '- "assertion" must repeat the assertion text verbatim, character for character.',
    '- "passed" is true only when the evidence supports the assertion.',
    '- "evidence" explains the verdict in one or two sentences.',
    '- "quote" is a short excerpt copied verbatim from the agent response or a workspace file that supports a passing verdict; use "" when there is nothing to quote.',
    '',
    '<task_prompt>',
    evalCase.prompt,
    '</task_prompt>',
    '',
    '<expected_output>',
    evalCase.expected_output,
    '</expected_output>',
    '',
    '<assertions>',
    JSON.stringify(stringAssertions, null, 2),
    '</assertions>',
    '',
    '<agent_response>',
    response || '(empty response)',
    '</agent_response>',
    '',
    '<workspace_files>',
    workspaceSummary.length > 0
      ? workspaceSummary.join('\n\n')
      : '(no workspace files)',
    '</workspace_files>',
  ].join('\n');
}

const graderResultItemSchema = z.looseObject({
  assertion: z.string(),
  passed: z.boolean(),
  evidence: z.string().transform((value) => value.trim()),
  quote: z
    .unknown()
    .optional()
    .transform((value) => (typeof value === 'string' ? value.trim() : '')),
});

const graderOutputEnvelopeSchema = z.looseObject({
  results: z.array(z.unknown()),
});

type GraderResultItem = z.infer<typeof graderResultItemSchema>;

function parseGraderItem(raw: unknown): GraderResultItem | null {
  const parsed = graderResultItemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function failedString(
  assertion: string,
  evidence: string,
): GradedExpectation {
  return { text: assertion, kind: 'string', passed: false, evidence };
}

export interface NormalizeGraderResultsParams {
  assertions: readonly string[];
  output: unknown;
  /**
   * Text the grader saw (response and workspace summary). When given, a passing
   * result whose `quote` does not occur in it is downgraded to failed.
   */
  evidenceText?: string;
}

/**
 * Matches grader results to assertions by exact text first. Results are taken
 * by position only when the grader returned exactly one result per assertion
 * and that slot was not already matched; anything else fails closed.
 */
export function normalizeGraderResults({
  assertions,
  output,
  evidenceText,
}: NormalizeGraderResultsParams): GradedExpectation[] {
  const envelope = graderOutputEnvelopeSchema.safeParse(output);

  if (!envelope.success) {
    return assertions.map((assertion) =>
      failedString(
        assertion,
        `${MALFORMED_GRADER_OUTPUT}: expected an object with a "results" array.`,
      ),
    );
  }

  const rawResults = envelope.data.results;

  const items = rawResults.map(parseGraderItem);
  const used = new Set<number>();
  const matched = new Array<GraderResultItem | undefined>(assertions.length);

  for (const [index, assertion] of assertions.entries()) {
    const found = items.findIndex(
      (item, position) =>
        item !== null && !used.has(position) && item.assertion === assertion,
    );

    if (found !== -1) {
      used.add(found);
      matched[index] = items[found] ?? undefined;
    }
  }

  if (items.length === assertions.length) {
    for (const index of assertions.keys()) {
      const item = items[index];

      if (matched[index] === undefined && !used.has(index) && item) {
        used.add(index);
        matched[index] = item;
      }
    }
  }

  const haystack =
    evidenceText === undefined ? undefined : collapseWhitespace(evidenceText);

  return assertions.map((assertion, index) => {
    const item = matched[index];

    if (item === undefined) {
      return failedString(
        assertion,
        `${MALFORMED_GRADER_OUTPUT}: no result matched this assertion (${rawResults.length} results for ${assertions.length} assertions).`,
      );
    }

    if (!item.evidence) {
      return failedString(assertion, 'Grader provided no supporting evidence.');
    }

    if (
      item.passed &&
      item.quote &&
      haystack !== undefined &&
      !haystack.includes(collapseWhitespace(item.quote))
    ) {
      return failedString(
        assertion,
        `Unverified evidence: the quoted text was not found in the response or workspace files. ${item.evidence}`,
      );
    }

    return {
      text: assertion,
      kind: 'string',
      passed: item.passed,
      evidence: item.evidence,
    };
  });
}
