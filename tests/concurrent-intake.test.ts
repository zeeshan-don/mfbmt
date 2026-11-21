import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rawDb } from "../src/lib/db-base";
import { ingestInboundMessage } from "../src/lib/workflow/enquiry";

const RUN = randomUUID().slice(0, 8);
const PHONE = `+97158${String(Math.floor(Math.random() * 900000) + 100000)}`;
const MESSAGE_IDS = Array.from({ length: 20 }, (_, index) => `burst-${RUN}-${index}`);

afterAll(async () => {
  const messages = await rawDb.message.findMany({
    where: { externalMessageId: { in: MESSAGE_IDS } },
    select: { conversationId: true },
  });
  const conversationIds = [...new Set(messages.map((message) => message.conversationId))];
  const conversations = await rawDb.conversation.findMany({
    where: { id: { in: conversationIds } },
    select: { contactId: true },
  });
  await rawDb.message.deleteMany({ where: { externalMessageId: { in: MESSAGE_IDS } } });
  await rawDb.conversation.deleteMany({ where: { id: { in: conversationIds } } });
  await rawDb.contact.deleteMany({
    where: { id: { in: conversations.flatMap((conversation) => (conversation.contactId ? [conversation.contactId] : [])) } },
  });
  await rawDb.backgroundJob.deleteMany({
    where: { organizationId: "org_mfbmt", payloadJson: { contains: `burst-${RUN}` } },
  });
});

describe("concurrent intake", () => {
  it("keeps one conversation when the same sender sends a burst of messages", async () => {
    const results = await Promise.all(
      MESSAGE_IDS.map((externalMessageId, index) =>
        ingestInboundMessage({
          channel: "WHATSAPP",
          externalMessageId,
          from: PHONE,
          body: `Please quote ${index + 1} pcs stainless elbow.`,
        }),
      ),
    );

    expect(results).toHaveLength(MESSAGE_IDS.length);
    expect(results.every((result) => result.duplicate === false)).toBe(true);

    const messages = await rawDb.message.findMany({
      where: { externalMessageId: { in: MESSAGE_IDS } },
      select: { conversationId: true },
    });
    expect(messages).toHaveLength(MESSAGE_IDS.length);
    // The conversation key is normalized from the sender, so assert on the
    // persisted relationship rather than reconstructing that key here.
    expect(new Set(messages.map((message) => message.conversationId)).size).toBe(1);
    const conversation = await rawDb.conversation.findUnique({
      where: { id: messages[0].conversationId },
    });
    expect(conversation?.organizationId).toBe("org_mfbmt");
    expect(conversation?.channel).toBe("WHATSAPP");
  });
});
