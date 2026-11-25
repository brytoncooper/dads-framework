use dads_testing_dst::{DstConfig, DstSummary, MutationKind, run_dst_sweep};
use std::env;
use std::path::PathBuf;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(value) => value,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!(
                "usage: dads-testing-dst [--scenarios N] [--steps K] [--seed S] [--jobs J] [--bin PATH] [--node PATH] [--filter MUTATION] [--keep-failed] [--json] [--allow-misses]"
            );
            process::exit(2);
        }
    };
    let summary = match run_dst_sweep(&parsed.config) {
        Ok(summary) => summary,
        Err(error) => {
            eprintln!("dst sweep error: {error}");
            process::exit(1);
        }
    };
    if parsed.json {
        if let Ok(text) = serde_json::to_string_pretty(&summary) {
            println!("{text}");
        }
    } else {
        print_human_summary(&summary, &parsed.config);
    }
    let has_failures = summary.soundness_misses_total > 0
        || summary.cache_integrity_violations > 0
        || summary.harness_errors > 0;
    if has_failures && !parsed.allow_misses {
        process::exit(1);
    }
}

struct ParsedArgs {
    config: DstConfig,
    json: bool,
    allow_misses: bool,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut scenarios = 100usize;
    let mut steps_per_scenario = 2usize;
    let mut base_seed = 1u64;
    let mut jobs = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(4);
    let mut dad_bin = default_dad_bin();
    let mut node_bin = find_in_path("node").unwrap_or_else(|| PathBuf::from("node"));
    let mut keep_failed = false;
    let mut json = false;
    let mut allow_misses = false;
    let mut filter_mutation = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--scenarios" => {
                i += 1;
                scenarios = parse_next(args, i, "--scenarios")?;
            }
            "--steps" => {
                i += 1;
                steps_per_scenario = parse_next(args, i, "--steps")?;
            }
            "--seed" => {
                i += 1;
                base_seed = parse_next(args, i, "--seed")?;
            }
            "--jobs" => {
                i += 1;
                jobs = parse_next(args, i, "--jobs")?;
            }
            "--bin" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| "--bin requires a path".to_owned())?;
                dad_bin = PathBuf::from(raw);
            }
            "--node" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| "--node requires a path".to_owned())?;
                node_bin = PathBuf::from(raw);
            }
            "--filter" => {
                i += 1;
                let raw = args
                    .get(i)
                    .ok_or_else(|| "--filter requires a mutation name".to_owned())?;
                filter_mutation = Some(
                    MutationKind::parse(raw)
                        .ok_or_else(|| format!("unknown mutation kind `{raw}`"))?,
                );
            }
            "--keep-failed" => keep_failed = true,
            "--json" => json = true,
            "--allow-misses" => allow_misses = true,
            other => return Err(format!("unknown argument `{other}`")),
        }
        i += 1;
    }

    Ok(ParsedArgs {
        config: DstConfig {
            dad_bin,
            node_bin,
            scenarios,
            steps_per_scenario,
            base_seed,
            jobs,
            keep_failed,
            max_sample_failures: 25,
            filter_mutation,
        },
        json,
        allow_misses,
    })
}

fn parse_next<T: std::str::FromStr>(
    args: &[String],
    index: usize,
    flag: &str,
) -> Result<T, String> {
    let raw = args
        .get(index)
        .ok_or_else(|| format!("{flag} requires a value"))?;
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
