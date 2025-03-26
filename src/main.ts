import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import 'source-map-support/register';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ExceptionsFilter } from './exception.filter';
import { LoggingInterceptor } from './logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  app.useGlobalFilters(new ExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      exceptionFactory: (errors) => {
        const result = errors.map((error) => ({
          property: error.property,
          message: error.constraints[Object.keys(error.constraints)[0]],
        }));
        return new BadRequestException(result);
      },
      transform: true,
      stopAtFirstError: true,
    }),
  );

  const options = new DocumentBuilder()
    .setTitle('Pawn API')
    .setVersion('0.0.1')

    .setVersion('v1')
    .addBearerAuth()
    .addSecurityRequirements('bearer')
    .build();
  const document = SwaggerModule.createDocument(app, options, {});
  SwaggerModule.setup('docs', app, document);

  await app.listen(3000);
}
bootstrap();
