import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !secretKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, secretKey, { auth: { persistSession: false } });

// High-resolution royalty-free Unsplash photography for Sri Lankan & artisanal bakery items
const REAL_CAKE_IMAGES = {
  "butter-cake": "https://images.unsplash.com/photo-1586985289688-ca3cf47d3e6e?w=800&auto=format&fit=crop&q=80",
  "chocolate-cake": "https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=800&auto=format&fit=crop&q=80",
  "ribbon-cake": "https://images.unsplash.com/photo-1535141192574-5d4897c13136?w=800&auto=format&fit=crop&q=80",
  "red-velvet-cake": "https://images.unsplash.com/photo-1616541823729-00fe0aacd32c?w=800&auto=format&fit=crop&q=80",
  "cheesecake": "https://images.unsplash.com/photo-1524351199678-941a58a3df50?w=800&auto=format&fit=crop&q=80",
  "birthday-cake": "https://images.unsplash.com/photo-1558301211-0d8c8ddee6ec?w=800&auto=format&fit=crop&q=80",
  "cup-cakes": "https://images.unsplash.com/photo-1576618148400-f54bed99fcfd?w=800&auto=format&fit=crop&q=80",
  "jar-cake": "https://images.unsplash.com/photo-1587314168485-3236d6710814?w=800&auto=format&fit=crop&q=80",
};

async function updateImages() {
  console.log("Updating product images with real bakery photography...");

  for (const [slug, imageUrl] of Object.entries(REAL_CAKE_IMAGES)) {
    const { data, error } = await supabase
      .from("products")
      .update({ image: imageUrl })
      .eq("slug", slug)
      .select("name, slug, image");

    if (error) {
      console.error(`Failed to update ${slug}:`, error.message);
    } else if (data && data.length > 0) {
      console.log(`Updated [${data[0].name}] with real photo.`);
    } else {
      console.log(`Product with slug [${slug}] not found.`);
    }
  }

  console.log("All product images updated successfully!");
}

updateImages().catch(console.error);
