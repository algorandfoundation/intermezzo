// main.spec.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Create spies for the Nest application methods
const useGlobalFiltersSpy = jest.fn();
const useGlobalInterceptorsSpy = jest.fn();
const setGlobalPrefixSpy = jest.fn();
const useGlobalPipesSpy = jest.fn();
const listenSpy = jest.fn().mockResolvedValue(undefined);

// Create a fake app that mimics the Nest application
const appMock = {
  useGlobalFilters: useGlobalFiltersSpy,
  useGlobalInterceptors: useGlobalInterceptorsSpy,
  setGlobalPrefix: setGlobalPrefixSpy,
  useGlobalPipes: useGlobalPipesSpy,
  get: jest.fn(),
  listen: listenSpy,
};

// Spy on NestFactory.create and have it return our fake app.
jest.spyOn(NestFactory, 'create').mockResolvedValue(appMock as any);

describe('Main bootstrap', () => {
  // Declare variables to hold our Swagger spies.
  let swaggerSetupSpy: jest.Mock;
  let createDocumentSpy: jest.Mock;

  beforeAll(async () => {
    // Define the spies for Swagger.
    swaggerSetupSpy = jest.fn();
    createDocumentSpy = jest.fn().mockReturnValue({});

    // Use jest.doMock so that the mock is applied at runtime (not hoisted).
    jest.doMock('@nestjs/swagger', () => ({
      SwaggerModule: {
        setup: swaggerSetupSpy,
        createDocument: createDocumentSpy,
      },
      DocumentBuilder: class {
        private config: Record<string, any> = {};
        setTitle(title: string) {
          this.config.title = title;
          return this;
        }
        setVersion(version: string) {
          this.config.version = version;
          return this;
        }
        addTag(tag: string) {
          this.config.tag = tag;
          return this;
        }
        addBearerAuth() {
          this.config.bearerAuth = true;
          return this;
        }
        addSecurityRequirements(security: string) {
          this.config.securityRequirements = security;
          return this;
        }
        build() {
          return this.config;
        }
      },
    }));

    // Dynamically import main.ts so that bootstrap runs with our mocks in place.
    await import('./main');
  });

  it('should call NestFactory.create with AppModule', () => {
    expect(NestFactory.create).toHaveBeenCalledWith(AppModule, expect.any(Object));
  });

  it('should set global filters, interceptors, prefix and pipes', () => {
    expect(useGlobalFiltersSpy).toHaveBeenCalled();
    expect(useGlobalInterceptorsSpy).toHaveBeenCalled();
    expect(setGlobalPrefixSpy).toHaveBeenCalledWith('v1');
    expect(useGlobalPipesSpy).toHaveBeenCalled();
  });

  it('should setup Swagger documentation', () => {
    expect(createDocumentSpy).toHaveBeenCalled();
    expect(swaggerSetupSpy).toHaveBeenCalled();
  });

  it('should call app.listen with port 3000', () => {
    expect(listenSpy).toHaveBeenCalledWith(3000);
  });
});
