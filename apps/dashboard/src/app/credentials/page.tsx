import { getCredentials } from "./actions";
import { CredentialsTable } from "./credentials-table";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;

export default async function CredentialsPage({
  searchParams,
}: {
  searchParams: Promise<{
    search?: string;
    page?: string;
    owner?: string;
    authScheme?: "bearer" | "basic" | "header" | "query" | "oauth_client" | "google_service_account";
    expired?: "yes" | "no";
    hasAccess?: string;
  }>;
}) {
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page || "1", 10) || 1);
  const { items, total } = await getCredentials(params.search, page, PAGE_SIZE, {
    ownerUserId: params.owner,
    authScheme: params.authScheme,
    expired: params.expired,
    hasAccessUserId: params.hasAccess,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Credentials</h1>
      <CredentialsTable
        credentials={items}
        total={total}
        page={page}
        pageSize={PAGE_SIZE}
        initialFilters={{
          ownerUserId: params.owner ?? "",
          authScheme: params.authScheme ?? "",
          expired: params.expired ?? "",
          hasAccessUserId: params.hasAccess ?? "",
        }}
      />
    </div>
  );
}
