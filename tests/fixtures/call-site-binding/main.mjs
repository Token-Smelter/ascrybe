import defaulted, { named as renamed } from './imported.mjs';
function local(value) { return value; }
local(1);
renamed(2);
defaulted(3);
const dynamic = local;
dynamic(4);
obj[method](5);
require('./legacy')(6);
