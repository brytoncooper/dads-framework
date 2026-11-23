//! One task, run as a child process: start it inside the workspace, capture both streams under a
//! fixed byte budget, and report an outcome rather than propagating a failure to start.
use super::results::{completed_task_result, task_error_result};
use crate::manifest::TaskExecution;
use crate::protocol::{TaskOutput, TaskRunResult};
use crate::scope::resolve_existing_inside;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Instant;

const OUTPUT_LIMIT_BYTES: usize = 64 * 1024;

struct CapturedStream {
    text: String,
    truncated: bool,
}

pub(super) fn execute_task(
    id: String,
    execution: TaskExecution,
    workspace_root: PathBuf,
) -> TaskRunResult {
    let started_at = Instant::now();
    let task_directory = match &execution.cwd {
        Some(cwd) => {
            match resolve_existing_inside(&workspace_root, Path::new(cwd), "execution.cwd") {
                Ok(directory) => directory,
                Err(error) => return task_error_result(id, started_at, error.to_string()),
            }
        }
        None => workspace_root,
    };
    let mut command = command_for(&execution);
    if !execution.env.is_empty() {
        command.envs(&execution.env);
    }
    let mut child = match command
        .current_dir(task_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return task_error_result(id, started_at, format!("Task could not start: {error}"));
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = stdout.map(|stream| thread::spawn(move || capture_stream(stream)));
    let stderr_reader = stderr.map(|stream| thread::spawn(move || capture_stream(stream)));
    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => {
            return task_error_result(id, started_at, format!("Task could not complete: {error}"));
        }
    };
    let stdout = join_capture(stdout_reader, "stdout");
    let stderr = join_capture(stderr_reader, "stderr");
    let duration_ms = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    match (stdout, stderr) {
        (Ok(stdout), Ok(stderr)) => {
            completed_task_result(id, status.code(), duration_ms, stdout, stderr)
        }
        (Err(error), _) | (_, Err(error)) => task_error_result(id, started_at, error),
    }
}

fn command_for(execution: &TaskExecution) -> Command {
    if execution.shell {
        let shell_command = std::iter::once(execution.executable.as_str())
            .chain(execution.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ");
        if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", &shell_command]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", &shell_command]);
            command
        }
    } else {
        let mut command = Command::new(&execution.executable);
        command.args(&execution.args);
        command
    }
}

fn capture_stream(mut stream: impl Read) -> Result<CapturedStream, String> {
    let mut captured = Vec::with_capacity(OUTPUT_LIMIT_BYTES);
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = stream
            .read(&mut buffer)
            .map_err(|error| format!("Unable to read task output: {error}"))?;
        if read == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT_BYTES.saturating_sub(captured.len());
        let kept = read.min(remaining);
        captured.extend_from_slice(&buffer[..kept]);
        if kept < read {
            truncated = true;
        }
    }
    Ok(CapturedStream {
        text: String::from_utf8_lossy(&captured).into_owned(),
        truncated,
    })
}

fn join_capture(
    reader: Option<thread::JoinHandle<Result<CapturedStream, String>>>,
    stream_name: &str,
) -> Result<Option<TaskOutput>, String> {
    let Some(reader) = reader else {
        return Ok(None);
    };
    let captured = reader
        .join()
        .map_err(|_| format!("Task {stream_name} capture worker panicked."))??;
    if captured.text.is_empty() && !captured.truncated {
        return Ok(None);
    }
    Ok(Some(TaskOutput {
        text: captured.text,
        truncated: captured.truncated,
    }))
}
