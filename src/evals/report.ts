import type {
  AssertionAggregate,
  BenchmarkSummary,
  EvalRunRecord,
  StatSummary,
  TriggerBenchmarkSummary,
  VariantAggregate,
} from './aggregate.ts';

const NOT_AVAILABLE = 'n/a';

/** Collapses every run of whitespace, newlines included, to one space. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Makes text safe inside one Markdown table cell. */
export function escapeTableCell(text: string): string {
  return collapseWhitespace(text).replaceAll('|', '\\|');
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return longest;
}

/**
 * Wraps text in an inline code span whose fence is longer than any backtick
 * run inside it, so the text cannot close the span early.
 */
export function codeSpan(text: string): string {
  const content = collapseWhitespace(text);
  const fence = '`'.repeat(longestBacktickRun(content) + 1);
  const padded =
    content.startsWith('`') || content.endsWith('`') ? ` ${content} ` : content;
  return `${fence}${padded}${fence}`;
}

/** A code span that is also safe inside a table cell. */
function cellCodeSpan(text: string): string {
  return codeSpan(text).replaceAll('|', '\\|');
}

/** Wraps multi-line text in a fenced code block it cannot close. */
export function codeBlock(text: string): string[] {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return [`${fence}text`, text.replace(/\r\n?/g, '\n'), fence];
}

/** Renders a 0..1 rate as a percentage, or "n/a" when it is undefined. */
export function formatRate(value: number | null | undefined): string {
  return value === null || value === undefined
    ? NOT_AVAILABLE
    : `${(value * 100).toFixed(1)}%`;
}

function formatStat(stat: StatSummary, decimals: number): string {
  return `${stat.mean.toFixed(decimals)} ± ${stat.stddev.toFixed(decimals)}`;
}

/**
 * Renders the difference of mean pass rates in percentage points, e.g.
 * "+33.3 pp".
 */
export function formatPassRateDelta(
  primary: VariantAggregate,
  reference: VariantAggregate,
): string {
  const points = (primary.pass_rate.mean - reference.pass_rate.mean) * 100;
  const fixed = points.toFixed(1);
  if (Number(fixed) === 0) return '+0.0 pp';
  return points > 0 ? `+${fixed} pp` : `${fixed} pp`;
}

function formatVariantRow(label: string, variant: VariantAggregate): string {
  const passRate = `${(variant.pass_rate.mean * 100).toFixed(1)}% ± ${(variant.pass_rate.stddev * 100).toFixed(1)}%`;
  const duration = `${formatStat(variant.time_seconds, 2)}s`;
  const tokens = variant.tokens ? formatStat(variant.tokens, 0) : NOT_AVAILABLE;
  const failed = `${variant.failed_runs}/${variant.runs}`;
  return `| ${label} | ${passRate} | ${duration} | ${tokens} | ${failed} |`;
}

interface DeltaRowParams {
  label: string;
  primary: VariantAggregate;
  reference: VariantAggregate;
  timeSeconds: string;
  tokens: string;
}

function formatDeltaRow({
  label,
  primary,
  reference,
  timeSeconds,
  tokens,
}: DeltaRowParams): string {
  const tokenCell = tokens === NOT_AVAILABLE ? tokens : `**${tokens}**`;
  return `| **${label}** | **${formatPassRateDelta(primary, reference)}** | **${timeSeconds}s** | ${tokenCell} | |`;
}

function formatAnalysisLine(label: string, items: readonly string[]): string {
  return `- **${label} (${items.length}):** ${items.map(codeSpan).join(', ')}`;
}

function formatRunHeading(run: EvalRunRecord): string {
  const tokens =
    run.timing.usage_reported === false
      ? 'tokens n/a'
      : `${run.timing.total_tokens} tokens`;
  const failure = run.timing.timed_out
    ? ', timed out'
    : run.timing.error
      ? ', failed'
      : '';
  return `#### ${codeSpan(run.variant)} - Run ${run.run_index} (${formatRate(run.grading.summary.pass_rate)}, ${run.timing.total_duration_seconds.toFixed(2)}s, ${tokens}${failure})`;
}

function formatAssertionRow(
  assertion: AssertionAggregate,
  withOldSkill: boolean,
): string {
  const cells = [
    escapeTableCell(assertion.text),
    cellCodeSpan(assertion.kind),
    formatRate(assertion.with_skill_pass_rate),
    formatRate(assertion.baseline_pass_rate),
    ...(withOldSkill ? [formatRate(assertion.old_skill_pass_rate)] : []),
    cellCodeSpan(assertion.classification),
    ...(withOldSkill
      ? [
          assertion.old_skill_classification
            ? cellCodeSpan(assertion.old_skill_classification)
            : NOT_AVAILABLE,
        ]
      : []),
  ];
  return `| ${cells.join(' | ')} |`;
}

export function renderBenchmarkReport(benchmark: BenchmarkSummary): string {
  const { metadata, run_summary: summary, cases } = benchmark;
  const lines: string[] = [
    `# Skill Evaluation Report: ${codeSpan(metadata.skill_name)}`,
    '',
    `- **Runner:** ${codeSpan(metadata.runner)}`,
    `- **Timestamp:** ${codeSpan(metadata.timestamp)}`,
    `- **Runs per configuration:** ${metadata.runs_per_configuration}`,
    `- **Baseline status:** ${metadata.baseline_status}`,
  ];
  if (metadata.compare_ref) {
    lines.push(`- **Compared against ref:** ${codeSpan(metadata.compare_ref)}`);
  }
  lines.push('');

  if (metadata.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of metadata.warnings) {
      lines.push(`- ${collapseWhitespace(warning)}`);
    }
    lines.push('');
  }

  lines.push(
    '## Overall Summary',
    '',
    'Means and sample standard deviations (sd) are taken across case runs: every run of every case for that variant. Failed runs count as failures; token statistics include only runs that reported usage.',
    '',
    '| Variant | Pass Rate (mean ± sd) | Duration (mean ± sd) | Total Tokens (mean ± sd) | Failed Runs |',
    '| --- | --- | --- | --- | --- |',
    formatVariantRow('`with_skill`', summary.with_skill),
  );
  if (summary.without_skill) {
    lines.push(formatVariantRow('`without_skill`', summary.without_skill));
  }
  if (summary.old_skill) {
    lines.push(formatVariantRow('`old_skill`', summary.old_skill));
  }
  if (summary.delta && summary.without_skill) {
    lines.push(
      formatDeltaRow({
        label: 'Delta (vs baseline)',
        primary: summary.with_skill,
        reference: summary.without_skill,
        timeSeconds: summary.delta.time_seconds,
        tokens: summary.delta.tokens,
      }),
    );
  }
  if (summary.old_skill_delta && summary.old_skill) {
    lines.push(
      formatDeltaRow({
        label: 'Delta (vs old_skill)',
        primary: summary.with_skill,
        reference: summary.old_skill,
        timeSeconds: summary.old_skill_delta.time_seconds,
        tokens: summary.old_skill_delta.tokens,
      }),
    );
  }
  lines.push('');

  if (benchmark.non_discriminating_assertions.length > 0) {
    lines.push(
      '## Non-Discriminating Assertions',
      '',
      'These assertions passed 100% in both `with_skill` and baseline runs:',
      '',
    );
    for (const item of benchmark.non_discriminating_assertions) {
      lines.push(`- ${codeSpan(item)}`);
    }
    lines.push('');
  }

  const analysis = benchmark.assertion_analysis;
  const analysisLines = [
    ['Pass only with skill', analysis.pass_only_with_skill],
    ['Regressing (vs baseline)', analysis.regressing],
    ['Regressing (vs old_skill)', analysis.regressing_vs_old],
    ['Pass in both', analysis.pass_in_both],
    ['Fail in both', analysis.fail_in_both],
    ['Flaky', analysis.flaky],
  ] as const;
  if (analysisLines.some(([, items]) => items.length > 0)) {
    lines.push('## Assertion Analysis', '');
    for (const [label, items] of analysisLines) {
      if (items.length > 0) lines.push(formatAnalysisLine(label, items));
    }
    lines.push('');
  }

  const withOldSkill = summary.old_skill !== undefined;
  lines.push('## Eval Cases', '');
  for (const evalCase of cases) {
    lines.push(
      `### Case: ${codeSpan(evalCase.case_id)}`,
      '',
      '**Prompt:**',
      '',
      ...codeBlock(evalCase.prompt),
      '',
      '**Expected Output:**',
      '',
      ...codeBlock(evalCase.expected_output),
      '',
    );

    if (evalCase.assertions.length > 0) {
      const header = [
        'Assertion',
        'Kind',
        '`with_skill`',
        '`without_skill`',
        ...(withOldSkill ? ['`old_skill`'] : []),
        'Classification',
        ...(withOldSkill ? ['vs `old_skill`'] : []),
      ];
      lines.push(
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
      );
      for (const assertion of evalCase.assertions) {
        lines.push(formatAssertionRow(assertion, withOldSkill));
      }
      lines.push('');
    }

    for (const run of evalCase.runs) {
      lines.push(formatRunHeading(run), '');
      if (run.timing.error) {
        lines.push(`- **Run error:** ${collapseWhitespace(run.timing.error)}`);
      }
      for (const exp of run.grading.expectations) {
        const badge = exp.passed ? 'PASS' : 'FAIL';
        lines.push(
          `- **[${badge}]** ${collapseWhitespace(exp.text)}: ${collapseWhitespace(exp.evidence)}`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

interface CountParams {
  value: number | null;
  numerator: number;
  denominator: number;
}

function formatRateWithCount({
  value,
  numerator,
  denominator,
}: CountParams): string {
  return `${formatRate(value)} (${numerator}/${denominator})`;
}

export function renderTriggerReport(summary: TriggerBenchmarkSummary): string {
  const { metadata, metrics, queries } = summary;
  const lines: string[] = [
    `# Trigger Evaluation Report: ${codeSpan(metadata.skill_name)}`,
    '',
    `- **Runner:** ${codeSpan(metadata.runner)}`,
    `- **Split:** ${codeSpan(metadata.split)}`,
    `- **Runs per query:** ${metadata.runs_per_query}`,
    `- **Threshold:** ${metadata.threshold}`,
    `- **Timestamp:** ${codeSpan(metadata.timestamp)}`,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Accuracy | ${formatRate(metrics.accuracy)} |`,
    ...(metrics.errored_queries > 0
      ? [
          `| Queries with only failed runs (excluded) | ${metrics.errored_queries}/${metrics.total_queries} |`,
        ]
      : []),
    `| Recall (Sensitivity) | ${formatRateWithCount({ value: metrics.recall, numerator: metrics.true_positives, denominator: metrics.positive_queries })} |`,
    `| Precision | ${formatRateWithCount({ value: metrics.precision, numerator: metrics.true_positives, denominator: metrics.true_positives + metrics.false_positives })} |`,
    `| Specificity | ${formatRateWithCount({ value: metrics.specificity, numerator: metrics.true_negatives, denominator: metrics.negative_queries })} |`,
    `| False Positive Rate | ${formatRateWithCount({ value: metrics.false_positive_rate, numerator: metrics.false_positives, denominator: metrics.negative_queries })} |`,
    '',
    '## Queries',
    '',
    '| Status | Expected | Trigger Rate | Query |',
    '| --- | --- | --- | --- |',
  ];

  for (const item of queries) {
    const status =
      item.trigger_rate === null ? 'ERROR' : item.passed ? 'PASS' : 'FAIL';
    const expected = item.should_trigger ? 'trigger' : 'no-trigger';
    const okRuns = item.runs - item.errored_runs;
    const errored =
      item.errored_runs > 0 ? `, ${item.errored_runs} failed` : '';
    const rate = `${item.trigger_count}/${okRuns} (${formatRate(item.trigger_rate)}${errored})`;
    lines.push(
      `| **${status}** | \`${expected}\` | ${rate} | ${escapeTableCell(item.query)} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}
