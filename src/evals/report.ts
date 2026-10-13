import type {
  BenchmarkSummary,
  StatSummary,
  TriggerBenchmarkSummary,
  VariantAggregate,
} from './aggregate.ts';

function formatStat(stat: StatSummary, decimals = 2): string {
  return `${stat.mean.toFixed(decimals)} ± ${stat.stddev.toFixed(decimals)}`;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatVariantRow(label: string, variant: VariantAggregate): string {
  const passRate = `${(variant.pass_rate.mean * 100).toFixed(1)}% ± ${(variant.pass_rate.stddev * 100).toFixed(1)}%`;
  const duration = `${formatStat(variant.time_seconds, 2)}s`;
  const tokens = formatStat(variant.tokens, 0);
  return `| ${label} | ${passRate} | ${duration} | ${tokens} |`;
}

export function renderBenchmarkReport(benchmark: BenchmarkSummary): string {
  const { metadata, run_summary: summary, cases } = benchmark;
  const lines: string[] = [
    `# Skill Evaluation Report: \`${metadata.skill_name}\``,
    '',
    `- **Runner:** \`${metadata.runner}\``,
    `- **Timestamp:** \`${metadata.timestamp}\``,
    `- **Runs per configuration:** ${metadata.runs_per_configuration}`,
    `- **Baseline status:** ${metadata.baseline_status}`,
  ];
  if (metadata.compare_ref) {
    lines.push(`- **Compared against ref:** \`${metadata.compare_ref}\``);
  }
  lines.push('');

  if (metadata.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of metadata.warnings) {
      lines.push(`- ${warning}`);
    }
    lines.push('');
  }

  lines.push(
    '## Overall Summary',
    '',
    '| Variant | Pass Rate (mean ± sd) | Duration (mean ± sd) | Total Tokens (mean ± sd) |',
    '| --- | --- | --- | --- |',
    formatVariantRow('`with_skill`', summary.with_skill),
  );
  if (summary.without_skill) {
    lines.push(formatVariantRow('`without_skill`', summary.without_skill));
  }
  if (summary.old_skill) {
    lines.push(formatVariantRow('`old_skill`', summary.old_skill));
  }
  if (summary.delta) {
    lines.push(
      `| **Delta (vs baseline)** | **${summary.delta.pass_rate}** | **${summary.delta.time_seconds}s** | **${summary.delta.tokens}** |`,
    );
  }
  if (summary.old_skill_delta) {
    lines.push(
      `| **Delta (vs old_skill)** | **${summary.old_skill_delta.pass_rate}** | **${summary.old_skill_delta.time_seconds}s** | **${summary.old_skill_delta.tokens}** |`,
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
      lines.push(`- \`${item}\``);
    }
    lines.push('');
  }

  const analysis = benchmark.assertion_analysis;
  if (
    analysis &&
    (analysis.pass_only_with_skill.length > 0 ||
      analysis.pass_in_both.length > 0 ||
      analysis.fail_in_both.length > 0 ||
      analysis.flaky.length > 0)
  ) {
    lines.push('## Assertion Analysis', '');
    if (analysis.pass_only_with_skill.length > 0) {
      lines.push(
        `- **Pass only with skill (${analysis.pass_only_with_skill.length}):** ${analysis.pass_only_with_skill.map((item) => `\`${item}\``).join(', ')}`,
      );
    }
    if (analysis.pass_in_both.length > 0) {
      lines.push(
        `- **Pass in both (${analysis.pass_in_both.length}):** ${analysis.pass_in_both.map((item) => `\`${item}\``).join(', ')}`,
      );
    }
    if (analysis.fail_in_both.length > 0) {
      lines.push(
        `- **Fail in both (${analysis.fail_in_both.length}):** ${analysis.fail_in_both.map((item) => `\`${item}\``).join(', ')}`,
      );
    }
    if (analysis.flaky.length > 0) {
      lines.push(
        `- **Flaky (${analysis.flaky.length}):** ${analysis.flaky.map((item) => `\`${item}\``).join(', ')}`,
      );
    }
    lines.push('');
  }

  lines.push('## Eval Cases', '');
  for (const evalCase of cases) {
    lines.push(
      `### Case: \`${evalCase.case_id}\``,
      '',
      `**Prompt:** ${evalCase.prompt}`,
      '',
      `**Expected Output:** ${evalCase.expected_output}`,
      '',
    );

    if (evalCase.assertions.length > 0) {
      lines.push(
        '| Assertion | Kind | `with_skill` | Baseline | Classification |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const assertion of evalCase.assertions) {
        const baseCell =
          assertion.baseline_pass_rate !== undefined
            ? formatRate(assertion.baseline_pass_rate)
            : assertion.old_skill_pass_rate !== undefined
              ? formatRate(assertion.old_skill_pass_rate)
              : 'n/a';
        lines.push(
          `| ${assertion.text.replaceAll('|', '\\|')} | \`${assertion.kind}\` | ${formatRate(assertion.with_skill_pass_rate)} | ${baseCell} | \`${assertion.classification}\` |`,
        );
      }
      lines.push('');
    }

    for (const run of evalCase.runs) {
      lines.push(
        `#### \`${run.variant}\` - Run ${run.run_index} (${formatRate(run.grading.summary.pass_rate)}, ${run.timing.total_duration_seconds}s, ${run.timing.total_tokens} tokens)`,
        '',
      );
      for (const exp of run.grading.expectations) {
        const badge = exp.passed ? 'PASS' : 'FAIL';
        lines.push(`- **[${badge}]** ${exp.text}: ${exp.evidence}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function renderTriggerReport(summary: TriggerBenchmarkSummary): string {
  const { metadata, metrics, queries } = summary;
  const lines: string[] = [
    `# Trigger Evaluation Report: \`${metadata.skill_name}\``,
    '',
    `- **Runner:** \`${metadata.runner}\``,
    `- **Split:** \`${metadata.split}\``,
    `- **Runs per query:** ${metadata.runs_per_query}`,
    `- **Threshold:** ${metadata.threshold}`,
    `- **Timestamp:** \`${metadata.timestamp}\``,
    '',
    '## Metrics',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Accuracy | ${formatRate(metrics.accuracy)} |`,
    `| Recall (Sensitivity) | ${formatRate(metrics.recall)} (${metrics.true_positives}/${metrics.positive_queries}) |`,
    `| Precision | ${formatRate(metrics.precision)} |`,
    `| Specificity | ${formatRate(metrics.specificity)} (${metrics.true_negatives}/${metrics.negative_queries}) |`,
    `| False Positive Rate | ${formatRate(metrics.false_positive_rate)} (${metrics.false_positives}/${metrics.negative_queries}) |`,
    '',
    '## Queries',
    '',
    '| Status | Expected | Trigger Rate | Query |',
    '| --- | --- | --- | --- |',
  ];

  for (const item of queries) {
    const status = item.passed ? 'PASS' : 'FAIL';
    const expected = item.should_trigger ? 'trigger' : 'no-trigger';
    const rate = `${item.trigger_count}/${item.runs} (${formatRate(item.trigger_rate)})`;
    lines.push(
      `| **${status}** | \`${expected}\` | ${rate} | ${item.query.replaceAll('|', '\\|')} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}
