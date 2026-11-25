use dads_testing_dst::{
    ChaosConfig, ChaosSummary, DstConfig, DstSummary, MutationKind, print_chaos_summary,
    run_chaos_sweep, run_dst_sweep,
};
use serde::Serialize;
use std::env;
use std::path::PathBuf;
use std::process;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CombinedSummary {
    curated: DstSummary,
    chaos: ChaosSummary,
}

struct ParsedArgs {
    curated: Option<DstConfig>,
    chaos: Option<ChaosConfig>,
    json: bool,
    allow_misses: bool,
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!(
                "usage: dads-testing-dst [--scenarios N] [--steps K] [--chaos N] [--chaos-steps K] [--shrink] [--seed S] [--jobs J] [--bin PATH] [--node PATH] [--filter MUTATION] [--keep-failed] [--json] [--allow-misses]"
            );
            process::exit(2);
        }
    };
    let curated_summary = parsed.curated.as_ref().map(|cfg| match run_dst_sweep(cfg) {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("dst sweep error: {error}");
            process::exit(1);
        }
    });
    let chaos_summary = parsed.chaos.as_ref().map(|cfg| match run_chaos_sweep(cfg) {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("chaos sweep error: {error}");
            process::exit(1);
        }
    });
    emit_output(&parsed, curated_summary.as_ref(), chaos_summary.as_ref());

    let curated_failed = curated_summary.as_ref().is_some_and(|s| {
        s.soundness_misses_total > 0 || s.cache_integrity_violations > 0 || s.harness_errors > 0
    });
    let chaos_failed = chaos_summary.as_ref().is_some_and(|s| {
        s.soundness_misses_total > 0
            || s.snapshot_parity_divergences > 0
            || s.cache_integrity_violations > 0
            || s.harness_errors > 0
    });
    if (curated_failed || chaos_failed) && !parsed.allow_misses {
        process::exit(1);
    }
}

fn emit_output(parsed: &ParsedArgs, curated: Option<&DstSummary>, chaos: Option<&ChaosSummary>) {
    if parsed.json {
        let encoded = match (curated, chaos) {
            (Some(c), Some(ch)) => serde_json::to_string_pretty(&CombinedSummary {
                curated: c.clone(),
                chaos: ch.clone(),
            }),
            (Some(c), None) => serde_json::to_string_pretty(c),
            (None, Some(ch)) => serde_json::to_string_pretty(ch),
            (None, None) => Ok("{}".to_owned()),
        };
        if let Ok(text) = encoded {
            println!("{text}");
        }
        return;
    }
    if let (Some(summary), Some(cfg)) = (curated, parsed.curated.as_ref()) {
        print_human_summary(summary, cfg);
    }
    if let (Some(summary), Some(cfg)) = (chaos, parsed.chaos.as_ref()) {
        if curated.is_some() {
            println!();
        }
        print_chaos_summary(summary, cfg);
    }
}

struct RawFlags {
    scenarios: Option<usize>,
    steps_per_scenario: usize,
    chaos_scenarios: Option<usize>,
    chaos_steps: usize,
    shrink: bool,
    base_seed: u64,
    jobs: usize,
    dad_bin: PathBuf,
    node_bin: PathBuf,
    keep_failed: bool,
    json: bool,
    allow_misses: bool,
    filter_mutation: Option<MutationKind>,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut raw = RawFlags {
        scenarios: None,
        steps_per_scenario: 2,
        chaos_scenarios: None,
        chaos_steps: 6,
        shrink: false,
        base_seed: 1,
        jobs: std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(4),
        dad_bin: default_dad_bin(),
        node_bin: find_in_path("node").unwrap_or_else(|| PathBuf::from("node")),
        keep_failed: false,
        json: false,
        allow_misses: false,
        filter_mutation: None,
    };

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scenarios" => {
                i += 1;
                raw.scenarios = Some(parse_next(args, i, "--scenarios")?);
            }
            "--steps" => {
                i += 1;
                raw.steps_per_scenario = parse_next(args, i, "--steps")?;
            }
            "--chaos" => {
                i += 1;
                raw.chaos_scenarios = Some(parse_next(args, i, "--chaos")?);
            }
            "--chaos-steps" => {
                i += 1;
                raw.chaos_steps = parse_next(args, i, "--chaos-steps")?;
            }
            "--shrink" => raw.shrink = true,
            "--seed" => {
                i += 1;
                raw.base_seed = parse_next(args, i, "--seed")?;
            }
            "--jobs" => {
                i += 1;
                raw.jobs = parse_next(args, i, "--jobs")?;
            }
            "--bin" => {
                i += 1;
                raw.dad_bin = PathBuf::from(parse_path_arg(args, i, "--bin")?);
            }
            "--node" => {
                i += 1;
                raw.node_bin = PathBuf::from(parse_path_arg(args, i, "--node")?);
            }
            "--filter" => {
                i += 1;
                let value = parse_path_arg(args, i, "--filter")?;
                raw.filter_mutation = Some(
                    MutationKind::parse(value)
                        .ok_or_else(|| format!("unknown mutation kind `{value}`"))?,
                );
            }
            "--keep-failed" => raw.keep_failed = true,
            "--json" => raw.json = true,
            "--allow-misses" => raw.allow_misses = true,
            other => return Err(format!("unknown argument `{other}`")),
        }
        i += 1;
    }

    Ok(build_parsed_args(raw))
}

fn build_parsed_args(raw: RawFlags) -> ParsedArgs {
    let run_curated =
        raw.scenarios.is_some() || raw.chaos_scenarios.is_none() || raw.filter_mutation.is_some();
    let curated = run_curated.then(|| DstConfig {
        dad_bin: raw.dad_bin.clone(),
        node_bin: raw.node_bin.clone(),
        scenarios: raw.scenarios.unwrap_or(100),
        steps_per_scenario: raw.steps_per_scenario,
        base_seed: raw.base_seed,
        jobs: raw.jobs,
        keep_failed: raw.keep_failed,
        max_sample_failures: 25,
        filter_mutation: raw.filter_mutation,
    });
    let chaos = raw
        .chaos_scenarios
        .filter(|&n| n > 0)
        .map(|scenarios| ChaosConfig {
            dad_bin: raw.dad_bin,
            node_bin: raw.node_bin,
            scenarios,
            steps_per_scenario: raw.chaos_steps,
            base_seed: raw.base_seed,
            jobs: raw.jobs,
            keep_failed: raw.keep_failed,
            shrink: raw.shrink,
            max_sample_failures: 25,
        });
    ParsedArgs {
        curated,
        chaos,
        json: raw.json,
        allow_misses: raw.allow_misses,
    }
}

fn parse_path_arg<'a>(args: &'a [String], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index)
        .map(String::as_str)
        .ok_or_else(|| format!("{flag} requires a value"))
}

fn parse_next<T: std::str::FromStr>(
    args: &[String],
    index: usize,
    flag: &str,
) -> Result<T, String> {
    let raw = parse_path_arg(args, index, flag)?;
    raw.parse::<T>()
        .map_err(|_| format!("invalid value `{raw}` for {flag}"))
}

fn default_dad_bin() -> PathBuf {
    if let Ok(current) = env::current_exe()
        && let Some(dir) = current.parent()
    {
        let candidate = dir.join("dad-test");
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from("dad-test")
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let paths = env::var_os("PATH")?;
    for dir in env::split_paths(&paths) {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn print_human_summary(summary: &DstSummary, config: &DstConfig) {
    let skip_pct = if summary.precision_checks_total == 0 {
        0.0
    } else {
        (summary.precision_skips_total as f64 / summary.precision_checks_total as f64) * 100.0
    };
    println!(
        "DST complete: {} scenarios ({} steps) in {}ms | oracle_failures={} | soundness_misses={} (stale_cache_hits={}) | cache_integrity_violations={} | harness_errors={} | noop_skip={:.1}% ({}/{})",
        summary.scenarios_run,
        summary.steps_executed,
        summary.elapsed_ms,
        summary.oracle_failures_total,
        summary.soundness_misses_total,
        summary.stale_cache_hits_total,
        summary.cache_integrity_violations,
        summary.harness_errors,
        skip_pct,
        summary.precision_skips_total,
        summary.precision_checks_total,
    );
    println!("\nBreakdown by mutation:");
    for (name, stats) in &summary.by_mutation {
        println!(
            "  {name:<48} steps={:<5} oracle_fail={:<5} misses={:<5} stale_cache={:<5}",
            stats.steps, stats.oracle_failures, stats.soundness_misses, stats.stale_cache_hits
        );
    }
    if !summary.sample_failures.is_empty() {
        println!(
            "\nSample failures (showing up to {}):",
            summary.sample_failures.len()
        );
        for failure in summary.sample_failures.iter().take(12) {
            println!(
                "  seed={} step={} mutation={} kind={} task={} file={} | {}",
                failure.seed,
                failure.step,
                failure.mutation.as_str(),
                failure.kind,
                failure.task_id,
                failure.test_file,
                failure.detail,
            );
            println!(
                "    repro: cargo run --release -p dads-testing-dst -- --bin {} --seed {} --scenarios 1 --steps {} --filter {} --keep-failed",
                config.dad_bin.display(),
                failure.seed,
                config.steps_per_scenario,
                failure.mutation.as_str(),
            );
        }
    }
}
