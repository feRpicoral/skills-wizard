import type {
  AssertionAggregate,
  BenchmarkSummary,
  CaseBenchmarkSummary,
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

function formatDeltaRow(params: {
  label: string;
  primary: VariantAggregate;
  reference: VariantAggregate;
  timeSeconds: string;
  tokens: string;
}): string {
  const tokenCell =
    params.tokens === NOT_AVAILABLE ? params.tokens : `**${params.tokens}**`;

  return `| **${params.label}** | **${formatPassRateDelta(params.primary, params.reference)}** | **${params.timeSeconds}s** | ${tokenCell} | |`;
}

function formatAnalysisLine(label: string, items: readonly string[]): string {
  return `- **${label} (${items.length}):** ${items.map(codeSpan).join(', ')}`;
}

function runFailureSuffix(run: EvalRunRecord): string {
  if (run.timing.timed_out) return ', timed out';
  if (run.timing.error) return ', failed';
  return '';
}

function formatRunHeading(run: EvalRunRecord): string {
  const tokens =
    run.timing.usage_reported === false
      ? 'tokens n/a'
      : `${run.timing.total_tokens} tokens`;
  const failure = runFailureSuffix(run);

  return `#### ${codeSpan(run.variant)} - Run ${run.run_index} (${formatRate(run.grading.summary.pass_rate)}, ${run.timing.total_duration_seconds.toFixed(2)}s, ${tokens}${failure})`;
}

function formatAssertionRow({
  assertion,
  hasBaseline,
  withOldSkill,
  compareSkillNames,
}: {
  assertion: AssertionAggregate;
  hasBaseline: boolean;
  withOldSkill: boolean;
  compareSkillNames: readonly string[];
}): string {
  const withCompareSkills = compareSkillNames.length > 0;
  const oldClassification =
    assertion.old_skill_classification ??
    (hasBaseline ? undefined : assertion.classification);
  const oldClassificationCell = oldClassification
    ? cellCodeSpan(oldClassification)
    : NOT_AVAILABLE;

  const cells = [
    escapeTableCell(assertion.text),
    cellCodeSpan(assertion.kind),
    formatRate(assertion.with_skill_pass_rate),
    ...(hasBaseline ? [formatRate(assertion.baseline_pass_rate)] : []),
    ...(withOldSkill ? [formatRate(assertion.old_skill_pass_rate)] : []),
    ...compareSkillNames.map((name) =>
      formatRate(assertion.compare_pass_rates?.[name]),
    ),
    ...(hasBaseline || (!withOldSkill && !withCompareSkills)
      ? [cellCodeSpan(assertion.classification)]
      : []),
    ...(withOldSkill ? [oldClassificationCell] : []),
    ...compareSkillNames.map((name, index) => {
      const compareClassification =
        assertion.compare_classifications?.[name] ??
        (!hasBaseline && !withOldSkill && index === 0
          ? assertion.classification
          : undefined);

      return compareClassification
        ? cellCodeSpan(compareClassification)
        : NOT_AVAILABLE;
    }),
  ];

  return `| ${cells.join(' | ')} |`;
}

function renderOverallSummarySection(
  summary: BenchmarkSummary['run_summary'],
  compareSkillNames: readonly string[],
): string[] {
  const lines: string[] = [
    '## Overall Summary',
    '',
    'Means and sample standard deviations (sd) are taken across case runs: every run of every case for that variant. Failed runs count as failures; token statistics include only runs that reported usage.',
    '',
    '| Variant | Pass Rate (mean ± sd) | Duration (mean ± sd) | Total Tokens (mean ± sd) | Failed Runs |',
    '| --- | --- | --- | --- | --- |',
    formatVariantRow('`with_skill`', summary.with_skill),
  ];

  if (summary.without_skill) {
    lines.push(formatVariantRow('`without_skill`', summary.without_skill));
  }
  if (summary.old_skill) {
    lines.push(formatVariantRow('`old_skill`', summary.old_skill));
  }
  for (const name of compareSkillNames) {
    const compareVariant = summary.compare_skills?.[name];
    if (compareVariant) {
      lines.push(
        formatVariantRow(cellCodeSpan(`compare:${name}`), compareVariant),
      );
    }
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
  for (const name of compareSkillNames) {
    const compareVariant = summary.compare_skills?.[name];
    const compareDelta = summary.compare_deltas?.[name];
    if (compareVariant && compareDelta) {
      lines.push(
        formatDeltaRow({
          label: `Delta (vs ${escapeTableCell(name)})`,
          primary: summary.with_skill,
          reference: compareVariant,
          timeSeconds: compareDelta.time_seconds,
          tokens: compareDelta.tokens,
        }),
      );
    }
  }

  lines.push('');

  return lines;
}

interface AssertionAnalysisSectionParams {
  benchmark: BenchmarkSummary;
  hasBaseline: boolean;
  withOldSkill: boolean;
  compareSkillNames: readonly string[];
}

/** The variant assertions are classified against, if any. */
function analysisReferenceLabel({
  hasBaseline,
  withOldSkill,
  compareSkillNames,
}: Omit<AssertionAnalysisSectionParams, 'benchmark'>): string | undefined {
  if (hasBaseline) return 'baseline';
  if (withOldSkill) return '`old_skill`';

  const firstCompareName = compareSkillNames[0];

  return firstCompareName === undefined
    ? undefined
    : codeSpan(`compare:${firstCompareName}`);
}

function renderAssertionAnalysisSection({
  benchmark,
  hasBaseline,
  withOldSkill,
  compareSkillNames,
}: AssertionAnalysisSectionParams): string[] {
  const lines: string[] = [];
  const referenceLabel = analysisReferenceLabel({
    hasBaseline,
    withOldSkill,
    compareSkillNames,
  });
  const vsReference = referenceLabel ? ` (vs ${referenceLabel})` : '';

  if (benchmark.non_discriminating_assertions.length > 0) {
    lines.push(
      '## Non-Discriminating Assertions',
      '',
      `These assertions passed 100% in both \`with_skill\` and ${referenceLabel ?? 'reference'} runs:`,
      '',
    );
    for (const item of benchmark.non_discriminating_assertions) {
      lines.push(`- ${codeSpan(item)}`);
    }
    lines.push('');
  }

  const analysis = benchmark.assertion_analysis;
  const analysisLines: (readonly [string, readonly string[]])[] = [
    [`Pass only with skill${vsReference}`, analysis.pass_only_with_skill],
    ...(hasBaseline
      ? ([['Regressing (vs baseline)', analysis.regressing]] as const)
      : []),
    ['Regressing (vs `old_skill`)', analysis.regressing_vs_old],
    ...compareSkillNames.map(
      (name) =>
        [
          `Regressing (vs ${codeSpan(`compare:${name}`)})`,
          analysis.regressing_vs_compare?.[name] ?? [],
        ] as const,
    ),
    [`Pass in both${vsReference}`, analysis.pass_in_both],
    [`Fail in both${vsReference}`, analysis.fail_in_both],
    [`Flaky${vsReference}`, analysis.flaky],
  ];

  if (analysisLines.some(([, items]) => items.length > 0)) {
    lines.push('## Assertion Analysis', '');
    for (const [label, items] of analysisLines) {
      if (items.length > 0) lines.push(formatAnalysisLine(label, items));
    }
    lines.push('');
  }

  return lines;
}

interface EvalCasesSectionParams {
  cases: readonly CaseBenchmarkSummary[];
  hasBaseline: boolean;
  withOldSkill: boolean;
  compareSkillNames: readonly string[];
}

function renderEvalCasesSection({
  cases,
  hasBaseline,
  withOldSkill,
  compareSkillNames,
}: EvalCasesSectionParams): string[] {
  const lines: string[] = ['## Eval Cases', ''];
  const withCompareSkills = compareSkillNames.length > 0;

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
      const primaryClassificationHeader = hasBaseline
        ? ['Classification (vs baseline)']
        : [];
      if (!hasBaseline && !withOldSkill && !withCompareSkills) {
        primaryClassificationHeader.push('Classification');
      }

      const header = [
        'Assertion',
        'Kind',
        '`with_skill`',
        ...(hasBaseline ? ['`without_skill`'] : []),
        ...(withOldSkill ? ['`old_skill`'] : []),
        ...compareSkillNames.map((name) => cellCodeSpan(`compare:${name}`)),
        ...primaryClassificationHeader,
        ...(withOldSkill ? ['Classification (vs `old_skill`)'] : []),
        ...compareSkillNames.map(
          (name) => `Classification (vs ${cellCodeSpan(`compare:${name}`)})`,
        ),
      ];

      lines.push(
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
      );

      for (const assertion of evalCase.assertions) {
        lines.push(
          formatAssertionRow({
            assertion,
            hasBaseline,
            withOldSkill,
            compareSkillNames,
          }),
        );
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

  return lines;
}

export function renderBenchmarkReport(benchmark: BenchmarkSummary): string {
  const { metadata, run_summary: summary, cases } = benchmark;
  const compareSkillNames =
    metadata.compare_skills ?? Object.keys(summary.compare_skills ?? {});

  const lines: string[] = [
    `# Skill Evaluation Report: ${codeSpan(metadata.skill_name)}`,
    '',
    `- **Runner:** ${codeSpan(metadata.runner)}`,
    `- **Timestamp:** ${codeSpan(metadata.timestamp)}`,
    `- **Runs per configuration:** ${metadata.runs_per_configuration}`,
    `- **Baseline status:** ${metadata.baseline_status}`,
    `- **\`with_skill\` status:** ${metadata.with_skill_contaminated ? 'possibly contaminated' : 'clean'}`,
  ];

  if (metadata.compare_ref) {
    lines.push(`- **Compared against ref:** ${codeSpan(metadata.compare_ref)}`);
  }

  if (compareSkillNames.length > 0) {
    lines.push(
      `- **Compared against skills:** ${compareSkillNames.map(codeSpan).join(', ')}`,
    );
  }

  lines.push('');

  if (metadata.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of metadata.warnings) {
      lines.push(`- ${collapseWhitespace(warning)}`);
    }
    lines.push('');
  }

  lines.push(...renderOverallSummarySection(summary, compareSkillNames));

  // Without baseline runs, assertions are classified against old_skill or the first compared skill.
  const hasBaseline = summary.without_skill !== undefined;
  const withOldSkill = summary.old_skill !== undefined;

  lines.push(
    ...renderAssertionAnalysisSection({
      benchmark,
      hasBaseline,
      withOldSkill,
      compareSkillNames,
    }),
    ...renderEvalCasesSection({
      cases,
      hasBaseline,
      withOldSkill,
      compareSkillNames,
    }),
  );

  return lines.join('\n');
}

function formatRateWithCount(params: {
  value: number | null;
  numerator: number;
  denominator: number;
}): string {
  return `${formatRate(params.value)} (${params.numerator}/${params.denominator})`;
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
    ...(metadata.possibly_contaminated
      ? ['- **Status:** possibly contaminated']
      : []),
    '',
  ];

  if (metadata.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of metadata.warnings) {
      lines.push(`- ${collapseWhitespace(warning)}`);
    }
    lines.push('');
  }

  lines.push(
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
  );

  for (const item of queries) {
    const status = triggerStatus(item);
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

function triggerStatus(item: {
  trigger_rate: number | null;
  passed: boolean;
}): string {
  if (item.trigger_rate === null) {
    return 'ERROR';
  }

  return item.passed ? 'PASS' : 'FAIL';
}
