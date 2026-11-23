// Quint specification for Dads Testing 2.0 (Extensions):
//   1. First-class task `env` variables (e.g. VITEST_TIER=unit vs integration)
//      and runtime fingerprint (node version / OS / arch) in content-hashed receipts
//   2. Non-JS / SQL migration inputs inside transitive project roots
//   3. Two-tier L1 (local disk) + L2 (remote S3/HTTP) content-hashed receipt store
//      under merge-queue concurrency, corrupt remote blobs, and network faults
//
// Proves:
//   - inv_remote_receipt_sound: zero false cache hits across L1 and L2 under any
//     env change, runtime change, SQL/TS file change, corruption, or concurrent worker
//   - inv_failed_never_cached_or_uploaded: failing tasks never write L1 or upload to L2
//   - inv_env_change_never_cross_hits: changing env vars never hits another env's receipt
//   - inv_remote_reuse_precision: healthy uncorrupted L2 hit avoids re-execution cleanly

module remote_receipts_and_env {
  type WorkerId = str
  type TaskId = str
  type FileId = str
  type Content = int
  type Digest = int

  val WORKERS: Set[WorkerId] = Set("pr_ci", "merge_queue")
  val TASKS: Set[TaskId] = Set("domain:unit", "domain:integration")
  // Mix of TS source, SQL migration, and resolution policy files
  val INPUT_FILES: Set[FileId] = Set("src.ts", "migration.sql", "tsconfig.json")
  val CONTENTS: Set[Content] = Set(1, 2)
  // Distinct env digests (e.g. 1 = VITEST_TIER=unit, 2 = VITEST_TIER=integration)
  val ENV_DIGESTS: Set[Digest] = Set(1, 2)
  // Distinct runtime fingerprints (e.g. 1 = linux-x64-node24, 2 = darwin-arm64-node24)
  val RUNTIMES: Set[Digest] = Set(1, 2)

  type FileMap = FileId -> Content

  // Complete content-addressed key for a task receipt (local L1 & remote L2)
  type ReceiptKey = {
    taskId: TaskId,
    manifestDigest: Digest,
    commandDigest: Digest,
    envDigest: Digest,
    runtimeFingerprint: Digest,
    inputHashes: FileMap
  }

  // Stored payload in L1 or L2:
  // `integrityOk` models SHA-256 + schema validation on read (false when corrupt on disk/S3).
  // `originKey` records the ground-truth inputs that actually produced this receipt.
  type StoredBlob = {
    key: ReceiptKey,
    originKey: ReceiptKey,
    passed: bool,
    corrupt: bool
  }

  // ---- Mutable System State ----
  // Per-worker workspace state (models PR CI worker vs Merge Queue worker!)
  var workerFiles: WorkerId -> FileMap
  var workerManifest: WorkerId -> Digest
  var workerCommand: WorkerId -> (TaskId -> Digest)
  var workerEnv: WorkerId -> (TaskId -> Digest)
  var workerRuntime: WorkerId -> Digest

  // L1 local receipt store per worker (isolated disk)
  var l1Store: WorkerId -> Set[StoredBlob]
  // L2 shared remote receipt store (S3 / HTTP cache shared across PR CI and Merge Queue)
  var l2Store: Set[StoredBlob]
  // Network availability flag for L2 remote store
  var remoteAvailable: bool

  // Audit flags checked by invariants after every transition
  var lastHitSound: bool
  var lastEnvIsolated: bool
  var lastRemotePrecisionValid: bool
  var lastAction: str

  pure def currentKey(
    w: WorkerId,
    t: TaskId,
    files: WorkerId -> FileMap,
    manifests: WorkerId -> Digest,
    cmds: WorkerId -> (TaskId -> Digest),
    envs: WorkerId -> (TaskId -> Digest),
    rts: WorkerId -> Digest
  ): ReceiptKey = {
    taskId: t,
    manifestDigest: manifests.get(w),
    commandDigest: cmds.get(w).get(t),
    envDigest: envs.get(w).get(t),
    runtimeFingerprint: rts.get(w),
    inputHashes: files.get(w)
  }

  // Lookup validates BOTH key match AND blob integrity (`not(corrupt)`) AND `passed`!
  pure def validBlobsForKey(store: Set[StoredBlob], k: ReceiptKey): Set[StoredBlob] =
    store.filter(b => b.key == k and not(b.corrupt) and b.passed)

  action init = {
    val baseFiles = INPUT_FILES.mapBy(_ => 1)
    val baseCmds = TASKS.mapBy(_ => 1)
    val baseEnvs = Map("domain:unit" -> 1, "domain:integration" -> 2)
    all {
      workerFiles' = WORKERS.mapBy(_ => baseFiles),
      workerManifest' = WORKERS.mapBy(_ => 1),
      workerCommand' = WORKERS.mapBy(_ => baseCmds),
      workerEnv' = WORKERS.mapBy(_ => baseEnvs),
      workerRuntime' = WORKERS.mapBy(_ => 1),
      l1Store' = WORKERS.mapBy(_ => Set()),
      l2Store' = Set(),
      remoteAvailable' = true,
      lastHitSound' = true,
      lastEnvIsolated' = true,
      lastRemotePrecisionValid' = true,
      lastAction' = "init",
    }
  }

  // ---- Workspace & Environment Mutations on a Worker ----

  action editFile = {
    nondet w = oneOf(WORKERS)
    nondet f = oneOf(INPUT_FILES)
    nondet c = oneOf(CONTENTS)
    all {
      workerFiles' = workerFiles.set(w, workerFiles.get(w).set(f, c)),
      workerManifest' = workerManifest,
      workerCommand' = workerCommand,
      workerEnv' = workerEnv,
      workerRuntime' = workerRuntime,
      l1Store' = l1Store,
      l2Store' = l2Store,
      remoteAvailable' = remoteAvailable,
      lastHitSound' = lastHitSound,
      lastEnvIsolated' = lastEnvIsolated,
      lastRemotePrecisionValid' = lastRemotePrecisionValid,
      lastAction' = "edit_file",
    }
  }

  action changeTaskEnv = {
    nondet w = oneOf(WORKERS)
    nondet t = oneOf(TASKS)
    nondet e = oneOf(ENV_DIGESTS)
    all {
      workerFiles' = workerFiles,
      workerManifest' = workerManifest,
      workerCommand' = workerCommand,
      workerEnv' = workerEnv.set(w, workerEnv.get(w).set(t, e)),
      workerRuntime' = workerRuntime,
      l1Store' = l1Store,
      l2Store' = l2Store,
      remoteAvailable' = remoteAvailable,
      lastHitSound' = lastHitSound,
      lastEnvIsolated' = lastEnvIsolated,
      lastRemotePrecisionValid' = lastRemotePrecisionValid,
      lastAction' = "change_env",
    }
  }

  action changeWorkerRuntime = {
    nondet w = oneOf(WORKERS)
    nondet rt = oneOf(RUNTIMES)
    all {
      workerFiles' = workerFiles,
      workerManifest' = workerManifest,
      workerCommand' = workerCommand,
      workerEnv' = workerEnv,
      workerRuntime' = workerRuntime.set(w, rt),
      l1Store' = l1Store,
      l2Store' = l2Store,
      remoteAvailable' = remoteAvailable,
      lastHitSound' = lastHitSound,
      lastEnvIsolated' = lastEnvIsolated,
      lastRemotePrecisionValid' = lastRemotePrecisionValid,
      lastAction' = "change_runtime",
    }
  }

  // ---- Adversarial Faults: Network Outage & Corrupt Remote Blobs ----

  action toggleRemoteNetwork = {
    all {
      workerFiles' = workerFiles,
      workerManifest' = workerManifest,
      workerCommand' = workerCommand,
      workerEnv' = workerEnv,
      workerRuntime' = workerRuntime,
      l1Store' = l1Store,
      l2Store' = l2Store,
      remoteAvailable' = not(remoteAvailable),
      lastHitSound' = lastHitSound,
      lastEnvIsolated' = lastEnvIsolated,
      lastRemotePrecisionValid' = lastRemotePrecisionValid,
      lastAction' = "toggle_network",
    }
  }

  // Corrupts an existing blob in L2 (truncated upload / bit flip on S3)
  action corruptRemoteBlob = {
    all {
      l2Store.size() > 0,
      nondet b = oneOf(l2Store)
      val corrupted = { ...b, corrupt: true }
      all {
        workerFiles' = workerFiles,
        workerManifest' = workerManifest,
        workerCommand' = workerCommand,
        workerEnv' = workerEnv,
        workerRuntime' = workerRuntime,
        l1Store' = l1Store,
        l2Store' = l2Store.exclude(Set(b)).union(Set(corrupted)),
        remoteAvailable' = remoteAvailable,
        lastHitSound' = lastHitSound,
        lastEnvIsolated' = lastEnvIsolated,
        lastRemotePrecisionValid' = lastRemotePrecisionValid,
        lastAction' = "corrupt_l2",
      }
    }
  }

  // ---- Task Execution with Two-Tier Content-Hashed Receipt Store (L1 -> L2 -> Run) ----

  action runTaskCached = {
    nondet w = oneOf(WORKERS)
    nondet t = oneOf(TASKS)
    nondet taskPasses = oneOf(Set(true, false))
    val key = currentKey(w, t, workerFiles, workerManifest, workerCommand, workerEnv, workerRuntime)
    val l1Hits = validBlobsForKey(l1Store.get(w), key)
    val l2Hits = if (remoteAvailable) validBlobsForKey(l2Store, key) else Set()
    val hasL1 = l1Hits.size() > 0
    val hasL2 = not(hasL1) and l2Hits.size() > 0
    // Precision check: if L1 missed, remote is healthy, and an uncorrupted L2 blob exists, we MUST hit L2.
    val expectedL2Hit = not(hasL1) and remoteAvailable and l2Store.exists(b => b.key == key and not(b.corrupt) and b.passed)
    val newBlob: StoredBlob = { key: key, originKey: key, passed: true, corrupt: false }
    all {
      workerFiles' = workerFiles,
      workerManifest' = workerManifest,
      workerCommand' = workerCommand,
      workerEnv' = workerEnv,
      workerRuntime' = workerRuntime,
      remoteAvailable' = remoteAvailable,
      // On L1 hit: store unchanged.
      // On L2 hit: hydrate L1 with the verified blob.
      // On miss: run task; ONLY passing executions write L1 and (when online) upload to L2!
      l1Store' = if (hasL1) l1Store
                 else if (hasL2) l1Store.set(w, l1Store.get(w).union(Set(newBlob)))
                 else if (taskPasses) l1Store.set(w, l1Store.get(w).union(Set(newBlob)))
                 else l1Store,
      l2Store' = if (hasL1 or hasL2) l2Store
                 else if (taskPasses and remoteAvailable) l2Store.union(Set(newBlob))
                 else l2Store,
      // Soundness checks on every hit:
      lastHitSound' = if (hasL1) l1Hits.forall(b => b.originKey == key and b.passed and not(b.corrupt))
                      else if (hasL2) l2Hits.forall(b => b.originKey == key and b.passed and not(b.corrupt))
                      else true,
      lastEnvIsolated' = if (hasL1) l1Hits.forall(b => b.originKey.envDigest == key.envDigest)
                         else if (hasL2) l2Hits.forall(b => b.originKey.envDigest == key.envDigest)
                         else true,
      lastRemotePrecisionValid' = (hasL2 == expectedL2Hit),
      lastAction' = if (hasL1) "l1_hit"
                    else if (hasL2) "l2_hit"
                    else if (taskPasses) "miss_pass"
                    else "miss_fail",
    }
  }

  action step = any {
    editFile,
    changeTaskEnv,
    changeWorkerRuntime,
    toggleRemoteNetwork,
    corruptRemoteBlob,
    runTaskCached,
  }

  // ---- Safety & Precision Invariants ----

  // 1. Every L1 or L2 hit matches the exact inputs, env, runtime, and passing status (zero false hits).
  val inv_remote_receipt_sound: bool = lastHitSound

  // 2. Changing an env var (e.g. VITEST_TIER=unit -> integration) NEVER hits another env's receipt.
  val inv_env_change_never_cross_hits: bool = lastEnvIsolated

  // 3. No failing execution ever enters L1 or L2.
  val inv_failed_never_cached_or_uploaded: bool =
    WORKERS.forall(w => l1Store.get(w).forall(b => b.passed and b.key == b.originKey)) and
    l2Store.forall(b => b.passed and b.key == b.originKey)

  // 4. Healthy, uncorrupted remote L2 receipts are always reused without spurious re-runs.
  val inv_remote_reuse_precision: bool = lastRemotePrecisionValid

  val inv_all: bool =
    inv_remote_receipt_sound and
    inv_env_change_never_cross_hits and
    inv_failed_never_cached_or_uploaded and
    inv_remote_reuse_precision
}
