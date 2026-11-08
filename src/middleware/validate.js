/**
 * Reusable middleware for validating request bodies, query, or params with Zod schemas.
 * @param {import('zod').ZodSchema} schema
 */
export function validateRequest(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message
        }))
      });
    }
    req.validatedBody = result.data;
    next();
  };
}
