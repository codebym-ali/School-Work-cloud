// Public API of @common — feature modules import only from here (ESLint boundaries §16).
export * from './common.module';
export * from './config/config.module';
export * from './config/env.schema';
export * from './config/school-settings.schema';
export * from './context/tenant-context';
export * from './crypto/field-encryption';
export * from './decorators/public.decorator';
export * from './decorators/roles.decorator';
export * from './decorators/current-user.decorator';
export * from './errors/app.error';
export * from './errors/error-codes';
export * from './errors/all-exceptions.filter';
export * from './guards/roles.guard';
export * from './guards/tenant-scope.guard';
export * from './redis/redis.module';
