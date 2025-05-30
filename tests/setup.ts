// tests/setup.ts
import { afterAll, beforeAll } from 'bun:test';
// Import postgres types correctly
import postgres from 'postgres';
import { PrismaPg } from '@prisma/adapter-pg';
import type { ListenRequest } from 'postgres';
import { createTriggers, TriggerManager } from '../src';
import { PrismaClient } from '@prisma/client';

// Global test objects
export let prisma: PrismaClient | null = null;
export let pgClient: postgres.Sql | null = null;
export let triggers: TriggerManager<PrismaClient> | null = null;

// Track active listen requests for proper cleanup
const activeListeners: ListenRequest[] = [];

// Notification channel trackers for tests
export const receivedNotifications: Record<string, any[]> = {
  insert_test: [],
  update_test: [],
  delete_test: [],
  condition_test: []
};

// Helper to get database URL
export function getDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Neither TEST_DATABASE_URL nor DATABASE_URL environment variable is set'
    );
  }
  return url;
}

// Helper to ensure database is initialized
export async function ensureDatabase() {
  if (prisma && pgClient && triggers) {
    return { prisma, pgClient, triggers };
  }
  
  console.log('Initializing database connection...');
  const DATABASE_URL = getDatabaseUrl();

  // Initialize if not already done
  if (!prisma) {
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: DATABASE_URL
      })
    });
  }

  if (!pgClient) {
    pgClient = postgres(DATABASE_URL);
  }

  if (!triggers) {
    triggers = createTriggers<typeof prisma>(DATABASE_URL);
  }

  return { prisma, pgClient, triggers };
}

// Use direct database connection for tests
// No pg-testdb required - keep it simple!
beforeAll(async () => {
  console.log('Setting up test environment...');
  console.log('Environment variables:');
  console.log('DATABASE_URL:', process.env.DATABASE_URL);
  console.log('TEST_DATABASE_URL:', process.env.TEST_DATABASE_URL);

  try {
    // Ensure database is initialized
    await ensureDatabase();
    
    const DATABASE_URL = getDatabaseUrl();

    console.log('Using database:', DATABASE_URL.replace(/:[^:]+@/, ':****@'));

    // Clean up any existing data for a fresh start
    console.log('Cleaning up existing data...');
    await prisma!.item.deleteMany({});
    await prisma!.list.deleteMany({});
    await prisma!.uwU.deleteMany({});
    await prisma!.user.deleteMany({});

    // Create notification functions for each test type
    console.log('Creating notification functions...');
    
    // Use the transaction API to create functions
    await triggers!.transaction(async (tx) => {
      // These functions are already created in individual tests,
      // but we'll create simple versions here for setup
      await tx`
        CREATE OR REPLACE FUNCTION insert_notify_func()
        RETURNS TRIGGER AS $$
        BEGIN
          PERFORM pg_notify('insert_test', 
            json_build_object(
              'operation', TG_OP,
              'timestamp', NOW(),
              'data', row_to_json(NEW)
            )::text
          );
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await tx`
        CREATE OR REPLACE FUNCTION update_notify_func()
        RETURNS TRIGGER AS $$
        BEGIN
          PERFORM pg_notify('update_test', 
            json_build_object(
              'operation', TG_OP,
              'timestamp', NOW(),
              'data', row_to_json(NEW)
            )::text
          );
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await tx`
        CREATE OR REPLACE FUNCTION delete_notify_func()
        RETURNS TRIGGER AS $$
        BEGIN
          PERFORM pg_notify('delete_test', 
            json_build_object(
              'operation', TG_OP,
              'timestamp', NOW(),
              'data', row_to_json(OLD)
            )::text
          );
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
      `;

      await tx`
        CREATE OR REPLACE FUNCTION condition_notify_func()
        RETURNS TRIGGER AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            PERFORM pg_notify('condition_test', 
              json_build_object(
                'operation', TG_OP,
                'timestamp', NOW(),
                'data', row_to_json(OLD)
              )::text
            );
            RETURN OLD;
          ELSE
            PERFORM pg_notify('condition_test', 
              json_build_object(
                'operation', TG_OP,
                'timestamp', NOW(),
                'data', row_to_json(NEW)
              )::text
            );
            RETURN NEW;
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `;
    });

    // Set up listeners for all notification channels
    console.log('Setting up notification listeners...');

    // Use raw postgres.js for listening to be sure notifications work
    if (pgClient) {
      // Set up raw listeners on each channel
      const channels = [
        'insert_test',
        'update_test',
        'delete_test',
        'condition_test'
      ];

      for (const channel of channels) {
        const listenRequest = pgClient.listen(channel, (payload) => {
          try {
            // Parse the payload
            const parsedPayload = JSON.parse(payload);
            // Store in our notification tracker
            // console.log(`Received notification on ${channel}:`, parsedPayload);
            receivedNotifications[channel].push(parsedPayload);
          } catch (error) {
            console.error(`Error handling notification on ${channel}:`, error);
          }
        });
        activeListeners.push(listenRequest);
      }
    }

    // Check what tables actually exist in the database
    console.log('Checking existing tables...');
    const tablesResult = await pgClient!.unsafe(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    console.log(
      'Tables in the database:',
      tablesResult.map((row) => row.table_name)
    );
  } catch (error) {
    console.error('Error in test setup:', error);
    throw error;
  }
});

// Cleanup after all tests
afterAll(async () => {
  console.log('Cleaning up test environment...');

  try {
    // Unsubscribe from all channels using the unlisten method
    for (const listener of activeListeners) {
      if (listener) {
        // Wait for the ListenRequest to resolve to ListenMeta
        const meta = await listener;
        // Call unlisten() on the meta object
        await meta.unlisten();
      }
    }

    // Clean up any test data
    if (prisma) {
      await prisma!.item.deleteMany({});
      await prisma!.list.deleteMany({});
      await prisma!.uwU.deleteMany({});
      await prisma!.user.deleteMany({});
    }

    // Dispose triggers
    if (triggers) {
      await triggers.dispose();
    }

    // Close connections
    // if (prisma) await prisma!.$disconnect();
    // if (pgClient) await pgClient.end();

    console.log('Test cleanup complete');
  } catch (error) {
    console.error('Error during test cleanup:', error);
  }
});

// Utility function to reset notification trackers
export function resetNotifications() {
  Object.keys(receivedNotifications).forEach((key) => {
    receivedNotifications[key] = [];
  });
}

/**
 * Wait for a specific number of notifications on a channel
 */
export async function waitForNotifications(
  channel: string,
  count: number,
  timeout: number = 2000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (receivedNotifications[channel].length >= count) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

/**
 * Assert that a notification payload has expected properties
 */
export function assertNotificationPayload(
  payload: any,
  expectedOperation: string,
  expectedData: Record<string, any>
) {
  if (!payload) {
    throw new Error(`Expected payload but got ${payload}`);
  }

  if (payload.operation !== expectedOperation) {
    throw new Error(
      `Expected operation ${expectedOperation} but got ${payload.operation}`
    );
  }

  if (!payload.timestamp) {
    throw new Error('Expected timestamp in payload');
  }

  // Check that each expected data property is present
  Object.entries(expectedData).forEach(([key, value]) => {
    if (value !== undefined) {
      if (payload.data[key] !== value) {
        throw new Error(
          `Expected data.${key} to be ${value} but got ${payload.data[key]}`
        );
      }
    } else if (payload.data[key] === undefined) {
      throw new Error(`Expected data.${key} to be defined`);
    }
  });
}