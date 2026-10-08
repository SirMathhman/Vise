// Tests must never write to the real audit log in ~/.vise.
process.env.VISE_AUDIT = "0";
