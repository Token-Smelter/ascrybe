function helper() { return 2; }
try { throw null; } catch (helper) { helper(); }
