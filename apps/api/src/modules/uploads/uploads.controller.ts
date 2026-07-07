import { Body, Controller, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { UploadsService } from './uploads.service';

class RequestUploadDto {
  @IsString() @MinLength(1) @MaxLength(200) filename!: string;
  @IsString() @MinLength(1) @MaxLength(100) mimeType!: string;
}

class ConfirmUploadDto {
  @IsString() @MinLength(1) @MaxLength(300) key!: string;
  @IsString() @MinLength(1) @MaxLength(100) mimeType!: string;
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post()
  request(@Body() dto: RequestUploadDto) {
    return this.uploads.requestUpload(dto.filename, dto.mimeType);
  }

  @Post('confirm')
  confirm(@Body() dto: ConfirmUploadDto) {
    return this.uploads.confirmUpload(dto.key, dto.mimeType);
  }
}
