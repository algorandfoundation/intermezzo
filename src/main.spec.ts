// main.spec.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Create spies for the Nest application methods
const useGlobalFiltersSpy = jest.fn();
const useGlobalInterceptorsSpy = jest.fn();
const setGlobalPrefixSpy = jest.fn();
const useGlobalPipesSpy = jest.fn();
const listenSpy = jest.fn().mockResolvedValue(undefined);
const useSpy = jest.fn();

// Stubs for the OID4VC providers fetched via `app.get(...)` during bootstrap.
const oid4vcAgentStub = { issuerRouter: jest.fn(), verifierRouter: jest.fn() };
const oid4vcConfigStub = {
  issuerPath: '/oid4vci',
  verifierPath: '/oid4vp',
  issuerMountPath: '/v1/oid4vci',
  verifierMountPath: '/v1/oid4vp',
};

// Create a fake app that mimics the Nest application
const appMock = {
  useGlobalFilters: useGlobalFiltersSpy,
  useGlobalInterceptors: useGlobalInterceptorsSpy,
  setGlobalPrefix: setGlobalPrefixSpy,
  useGlobalPipes: useGlobalPipesSpy,
  use: useSpy,
  get: jest.fn((token) => {
    const name = (token && (token.name as string)) || '';
    if (name === 'Oid4vcAgentProvider') return oid4vcAgentStub;
    if (name === 'Oid4vcConfig') return oid4vcConfigStub;
    return undefined;
  }),
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
        addApiKey(options: any, name: string) {
          this.config.apiKey = { options, name };
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

  it('should mount the OID4VC issuer and verifier routers at their configured mount paths', () => {
    expect(useSpy).toHaveBeenCalledWith('/v1/oid4vci', expect.anything());
    expect(useSpy).toHaveBeenCalledWith('/v1/oid4vp', expect.anything());
  });
});
