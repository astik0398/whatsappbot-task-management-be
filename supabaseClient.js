const { createClient } = require('@supabase/supabase-js');
require("dotenv").config();

const supabasekey = process.env.SUPABASE_ANON_KEY
const supabaseurl = process.env.SUPABASE_URL

const supabase = createClient(supabaseurl, supabasekey)


module.exports = supabase