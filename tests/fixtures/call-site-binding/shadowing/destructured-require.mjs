function helper() { return 2; }
{
  const { helper } = require('./dependency');
  helper();
}
