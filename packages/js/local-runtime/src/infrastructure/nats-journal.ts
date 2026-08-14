/**
 * JournalPort over the local event fabric — the `h-journal` JetStream stream, one subject per
 * run group, every record published with a `<group>:<seq>` `Nats-Msg-Id` (the fabric's dedup
 * idiom, shared with the relay's step hand-offs).
 *
 * Connection-per-call is deliberate: appends happen once per completed STAGE (minutes apart),
 * and a held connection would be one more thing to clean up on every exit path of a process
 * whose whole job is to die well. The driver's preflight has already ensured the server answers
 * and the stream exists; a connect failure here is therefore a real fault, not a bring-up gap.
 */
import { Effect, Layer } from "effect";
import { connect, type JetStreamClient, type NatsConnection } from "nats";

import type { JournalRecord } from "../domain/models.ts";
import { JournalError, JournalPort } from "../domain/ports.ts";

/** Mirrors the Python protocol constants (events_protocol.py) — the stream is driver-ensured. */
const JOURNAL_STREAM = "h-journal";
const journalSubject = (group: string) => `h.journal.${group}`;

const withConnection = <A>(
  url: string,
  group: string,
  use: (js: JetStreamClient, nc: NatsConnection) => Promise<A>,
): Effect.Effect<A, JournalError> =>
  Effect.tryPromise({
    try: async () => {
      const nc = await connect({ servers: url, timeout: 3000, maxReconnectAttempts: 2 });
      try {
        return await use(nc.jetstream(), nc);
      } finally {
        await nc.drain();
      }
    },
    catch: (cause) => new JournalError({ group, cause }),
  });

export const NatsJournalLive = Layer.succeed(JournalPort, {
  replay: (url, group) =>
    withConnection(url, group, async (js) => {
      const records: JournalRecord[] = [];
      // An ordered ephemeral consumer filtered to this group's subject — the `h events await`
      // pattern: replay everything retained, leave nothing durable behind.
      const consumer = await js.consumers.get(JOURNAL_STREAM, {
        filterSubjects: [journalSubject(group)],
      });
      const decoder = new TextDecoder();
      for (;;) {
        const batch = await consumer.fetch({ max_messages: 200, expires: 2000 });
        let got = 0;
        for await (const message of batch) {
          got += 1;
          records.push(JSON.parse(decoder.decode(message.data)) as JournalRecord);
        }
        if (got === 0) break;
      }
      return records;
    }),
  append: (url, group, record) =>
    withConnection(url, group, async (js) => {
      await js.publish(journalSubject(group), new TextEncoder().encode(JSON.stringify(record)), {
        msgID: `${group}:${record.seq}`,
      });
    }),
});
