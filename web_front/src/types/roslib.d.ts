declare namespace ROSLIB {
  interface RosOptions {
    url: string;
  }

  class Ros {
    constructor(options: RosOptions);
    on(event: "connection" | "error" | "close", callback: (event?: unknown) => void): void;
    close(): void;
  }

  interface TopicOptions {
    ros: Ros;
    name: string;
    messageType: string;
  }

  class Topic {
    constructor(options: TopicOptions);
    subscribe(callback: (message: Record<string, unknown>) => void): void;
    unsubscribe(): void;
    publish(message: Message): void;
  }

  class Message {
    constructor(values: Record<string, unknown>);
  }

  interface ServiceOptions {
    ros: Ros;
    name: string;
    serviceType: string;
  }

  class Service {
    constructor(options: ServiceOptions);
    callService(
      request: ServiceRequest,
      callback: (response: Record<string, unknown>) => void
    ): void;
  }

  class ServiceRequest {
    constructor(values: Record<string, unknown>);
  }
}

interface Window {
  ROSLIB: typeof ROSLIB;
}
