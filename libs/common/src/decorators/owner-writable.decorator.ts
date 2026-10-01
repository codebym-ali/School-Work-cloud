import { SetMetadata } from '@nestjs/common';

export const OWNER_WRITABLE_KEY = 'ownerWritable';
export const OwnerWritable = () => SetMetadata(OWNER_WRITABLE_KEY, true);
