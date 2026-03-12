import { getConversations } from "./actions";
import { ConversationsTable } from "./conversations-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ sourceType?: string; search?: string; page?: string }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);
  const { items, total } = await getConversations(
    params.sourceType,
    params.search,
    page,
    PAGE_SIZE,
  );

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Conversations</h1>
      <ConversationsTable
        conversations={items}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
