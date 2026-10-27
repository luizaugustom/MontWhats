/**
 * CLI helper: creates a tenant via HTTP admin endpoint.
 * Usage:
 *   MASTER_ADMIN_KEY=... API_URL=http://localhost:3000 npm run create-tenant -- "Minha Empresa"
 */
const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run create-tenant -- "Tenant Name"');
  process.exit(1);
}

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const masterKey =
  process.env.MASTER_ADMIN_KEY ?? "change-me-to-a-long-random-secret";

async function run() {
  const res = await fetch(`${apiUrl}/admin/tenants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": masterKey,
    },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(data);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
