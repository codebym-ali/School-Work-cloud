import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { PdfService } from '../pdf/pdf.service';

/** Global object-storage + PDF rendering (blueprint §22.6, §11/§13/§15). */
@Global()
@Module({
  providers: [StorageService, PdfService],
  exports: [StorageService, PdfService],
})
export class StorageModule {}
