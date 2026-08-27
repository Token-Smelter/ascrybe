function helper() { return 2; }
{
  const { helper } = dependencies;
  helper();
}
