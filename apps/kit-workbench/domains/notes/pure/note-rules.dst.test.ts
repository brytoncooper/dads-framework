import {
  createFaultyDeliveryQueue,
  createFaultyTransactionRunner,
  defineSimAction,
  defineSimulation,
  runSimulation,
} from "@dads-framework/testing/dst";
import { describe, expect, it } from "vitest";
import { noteIdSchema } from "../contract/wire.js";
import {
  buildNoteExportFilename,
  createNoteRecord,
  escapeCsvFormulaCell,
  type NoteExportFormat,
  type NoteRecord,
} from "./note-rules.js";

describe("note-rules DST simulation", () => {
  it("preserves normalization, idempotency, and CSV safety under 40001 retries and duplicate delivery", async () => {
    type NoteCommand = {
      readonly opId: string;
      readonly noteId: string;
      readonly tenantId: string;
      readonly rawText: string;
    };

    type State = {
      readonly tx: ReturnType<typeof createFaultyTransactionRunner>;
      readonly queue: ReturnType<typeof createFaultyDeliveryQueue<NoteCommand>>;
      readonly notes: Map<string, NoteRecord>;
      readonly appliedOps: Set<string>;
      readonly tenantIds: readonly string[];
    };

    const sampleTexts = [
      "  Hello\r\nworld  ",
      "=SUM(A1:A5)",
      "  +cmd\rnext line",
      "-flag\r\nbody",
      "@mention\tvalue ",
      "Ordinary note text",
    ];

    const spec = defineSimulation<State>({
      name: "notes-pure-idempotent-dst",
      createState: (world) => ({
        tx: createFaultyTransactionRunner(world, { serializationFailureRate: 0.3, deadlockRate: 0.05, maxAttempts: 8 }),
        queue: createFaultyDeliveryQueue<NoteCommand>(world, {
          duplicateRate: 0.45,
          dropRate: 0,
          reorderRate: 0.5,
          maxDelayMs: 120,
        }),
        notes: new Map(),
        appliedOps: new Set(),
        tenantIds: [world.nextUuidV7(), world.nextUuidV7()],
      }),
      actions: [
        defineSimAction({
          name: "enqueue-note",
          weight: 4,
          generate: (state, world) => ({
            opId: world.nextUuidV7(),
            noteId: world.nextUuidV7(),
            tenantId: world.rng.pick(state.tenantIds),
            rawText: world.rng.pick(sampleTexts),
          }),
          execute: (state, cmd) => {
            state.queue.enqueue(cmd, cmd.opId);
          },
        }),
        defineSimAction({
          name: "deliver-batch",
          weight: 3,
          enabled: (state) => state.queue.pendingCount() > 0,
          generate: (_state, world) => world.rng.int(10, 150),
          execute: async (state, advanceMs, world) => {
            world.clock.advance(advanceMs);
            await state.queue.deliverNext(async (envelope) => {
              await state.tx.run(() => {
                if (state.appliedOps.has(envelope.messageId)) return;
                const parsedId = noteIdSchema.parse(envelope.payload.noteId);
                const record = createNoteRecord({
                  id: parsedId,
                  tenantId: envelope.payload.tenantId,
                  text: envelope.payload.rawText,
                });
                state.appliedOps.add(envelope.messageId);
                state.notes.set(record.id, record);
              });
            });
          },
        }),
      ],
      invariants: [
        {
          name: "normalized-and-csv-safe",
          check: (state) => {
            for (const record of state.notes.values()) {
              expect(noteIdSchema.safeParse(record.id).success).toBe(true);
              expect(record.text).not.toContain("\r");
              expect(record.text).toBe(record.text.trim());

              const escaped = escapeCsvFormulaCell(record.text);
              expect(/^[\s]*[=+\-@]/u.test(escaped)).toBe(false);

              for (const format of ["csv", "pdf"] satisfies readonly NoteExportFormat[]) {
                expect(buildNoteExportFilename(record.id, format)).toMatch(/^note-[a-z0-9]{1,8}\.(csv|pdf)$/u);
              }
            }
          },
        },
        {
          name: "idempotent-apply-count",
          check: (state) => {
            expect(state.notes.size).toBe(state.appliedOps.size);
          },
        },
      ],
    });

    const report = await runSimulation(spec, { seeds: 15, steps: 35 });
    expect(report.ok).toBe(true);
  });
});
