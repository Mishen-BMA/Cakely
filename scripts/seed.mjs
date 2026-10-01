// One-time seed script. Run locally with your env vars set:
//   SUPABASE_URL=... SUPABASE_SECRET_KEY=... ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 node scripts/seed.mjs
// or `npm run seed` from the repo root after copying .env.example to .env and filling it in.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import bcrypt from "bcryptjs";

const supabaseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;
if (!supabaseUrl || !secretKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in your environment (.env).");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });

const PRODUCTS = [
  ["Homemade Butter Cake", "butter-cake", "Soft, golden, and baked with real butter.", "Classic cakes", 1800],
  ["Chocolate Cake", "chocolate-cake", "Rich cocoa layers finished with silky chocolate cream.", "Classic cakes", 2400],
  ["Ribbon Cake", "ribbon-cake", "A Sri Lankan celebration classic with delicate layers.", "Classic cakes", 2200],
  ["Red Velvet Cake", "red-velvet-cake", "Velvety cocoa sponge with cream cheese frosting.", "Special cakes", 3200],
  ["Cheesecake", "cheesecake", "A smooth baked cheesecake with a biscuit base.", "Special cakes", 3600],
  ["Birthday Cake", "birthday-cake", "Made-to-celebrate layers with your message on top.", "Special cakes", 3000],
  ["Cup Cakes", "cup-cakes", "A box of six petite cakes for sharing.", "Small treats", 1500],
  ["Jar Cake", "jar-cake", "Layered cake and cream in a take-anywhere jar.", "Small treats", 900],
];

const SIZE_MULTIPLIERS = { "1 kg": 1, "2 kg": 2, "3 kg": 3, "5 kg": 5, "7 kg": 7, "10 kg": 10 };
const FLAVOURS = ["Vanilla", "Chocolate", "Coffee", "Fruit", "Butterscotch", "Coconut"];

const COUPONS = [
  ["CAKE10", "10% off your cake order", "PERCENTAGE", 10, 0],
  ["CAKE20", "20% off your cake order", "PERCENTAGE", 20, 0],
  ["CAKE30", "30% off your cake order", "PERCENTAGE", 30, 0],
  ["CAKE50", "50% off your cake order", "PERCENTAGE", 50, 0],
  ["SAVE500", "Rs. 500 off orders over Rs. 2500", "FIXED", 500, 2500],
  ["FIRSTCAKE", "Rs. 1000 off a first order", "FIXED", 1000, 3000],
  ["FREEDESSERT", "Free delivery for demonstrations", "FREE_DELIVERY", 0, 0],
];

async function seedAdmin() {
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";
  const passwordHash = await bcrypt.hash(password, 10);
  const email = `${username}@cakely.lk`;

  const { data: existing } = await supabase.from("users").select("id").or(`username.eq.${username},email.eq.${email}`).maybeSingle();
  if (existing) {
    await supabase.from("users").update({ username, email, is_admin: true, password_hash: passwordHash }).eq("id", existing.id);
    console.log(`Admin user updated (${username}).`);
  } else {
    await supabase.from("users").insert({ username, email, is_admin: true, password_hash: passwordHash });
    console.log(`Admin user created (${username}).`);
  }
}

async function seedProducts() {
  const { count } = await supabase.from("products").select("id", { count: "exact", head: true });
  if (count && count > 0) {
    console.log(`Products already exist (${count}) — skipping product seed.`);
    return;
  }
  const rows = PRODUCTS.map(([name, slug, description, category, price]) => ({
    name,
    slug,
    description,
    category,
    base_price: price,
    image: `https://placehold.co/600x400?text=${encodeURIComponent(name)}`,
    flavours: FLAVOURS,
    sizes: Object.fromEntries(Object.entries(SIZE_MULTIPLIERS).map(([size, mult]) => [size, Math.round(price * mult)])),
    active: true,
  }));
  const { error } = await supabase.from("products").insert(rows);
  if (error) throw error;
  console.log(`Seeded ${rows.length} products (with placeholder images — replace via the admin panel).`);
}

async function seedCoupons() {
  for (const [code, description, discount_type, discount_value, minimum_order] of COUPONS) {
    const { data: existing } = await supabase.from("coupons").select("id").eq("code", code).maybeSingle();
    if (existing) continue;
    await supabase.from("coupons").insert({ code, description, discount_type, discount_value, minimum_order, can_stack: false, active: true });
  }
  console.log("Coupons seeded.");
}

async function seedPlatformSettings() {
  const { error } = await supabase.from("platform_settings").upsert({ id: 1, rulelock_enabled: false }, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw error;
  console.log("Platform settings seeded.");
}

async function main() {
  await seedAdmin();
  await seedProducts();
  await seedCoupons();
  await seedPlatformSettings();
  console.log("Cakely seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
