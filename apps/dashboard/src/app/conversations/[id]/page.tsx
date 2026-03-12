import { notFound } from "next/navigation";
import { getConversation } from "../actions";
import { ConversationDetail } from "./conversation-detail";

export const dynamic = "force-dynamic";

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await getConversation(id);
  if (!data) return notFound();

  return (
    <div className="space-y-4">
      <ConversationDetail data={data} />
    </div>
  );
}
