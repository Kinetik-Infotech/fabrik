supabase-js 2.119.0, bundled into one file with esbuild 0.25.12, its own dependencies included:

```sh
npm i @supabase/supabase-js@2.119.0 esbuild@0.25.12
echo 'export { createClient } from "@supabase/supabase-js";' > entry.mjs
npx esbuild entry.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof --outfile=supabase.mjs
```

A new version goes in a new folder, with its own SHA256SUMS.
