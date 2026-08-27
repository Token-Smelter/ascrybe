const literal = value => value && !/[+${}]/.test(value) ? 'literal' : 'dynamic';

export default {
  kind: 'aws_usage',
  filePattern: /\.(?:cs|py|[cm]?[jt]sx?)$/i,
  scan(lines, ctx) {
    const facts = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/PublishAsync|\.publish\s*\(/i.test(line)) {
        const match = line.match(/(?:TopicArn|topic_arn)\s*[=:]\s*["']([^"']+)["']/i);
        facts.push(ctx.fact('aws_usage', index + 1, {
          service: 'sns',
          op: 'publish',
          target_name_or_expr: match?.[1] || 'dynamic',
          status: match ? 'literal' : 'dynamic',
        }));
      }
      if (/GetParameter(?:Async)?|get_parameter/i.test(line)) {
        const match = line.match(/(?:Name|name)\s*[=:]\s*["']([^"']+)["']/);
        const target = match?.[1] || 'dynamic';
        facts.push(ctx.fact('aws_usage', index + 1, {
          service: 'ssm',
          op: 'get_parameter',
          target_name_or_expr: target,
          status: literal(target),
        }));
        if (match) {
          facts.push(ctx.fact('config_key', index + 1, {
            key_name: target,
            role: 'read',
          }));
        }
      }
      const basic = line.match(/\b(SQS|S3|DynamoDB).*?\b(SendMessage|PutObject|GetObject|PutItem|GetItem)(?:Async)?\b/i);
      if (basic) {
        facts.push(ctx.fact('aws_usage', index + 1, {
          service: basic[1].toLowerCase(),
          op: basic[2].toLowerCase(),
          target_name_or_expr: 'dynamic',
          status: 'dynamic',
        }));
      }
    }
    return facts;
  },
};
