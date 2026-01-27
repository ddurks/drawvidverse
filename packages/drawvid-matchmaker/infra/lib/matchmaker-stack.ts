import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Construct } from 'constructs';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

export class MatchmakerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, gameKey: string = 'cyberia', props?: cdk.StackProps) {
    super(scope, id, props);

    // Load game configuration
    const gameConfigPath = join(__dirname, '../../../..', 'games', `${gameKey}.config.json`);
    const gameConfig = JSON.parse(readFileSync(gameConfigPath, 'utf-8'));
    // DynamoDB Table
    // ========================================================================
    const table = new dynamodb.Table(this, 'DrawvidVerseTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
    });

    // ========================================================================
    // JWT Secret
    // ========================================================================
    const jwtSecret = new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: 'drawvidverse/jwt-secret',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'secret',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    // ========================================================================
    // VPC
    // ========================================================================
    const vpc = new ec2.Vpc(this, 'DrawvidVerseVpc', {
      maxAzs: 2,
      natGateways: 0, // No NAT gateway needed (public subnets only)
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // ========================================================================
    // ECS Cluster
    // ========================================================================
    const cluster = new ecs.Cluster(this, 'DrawvidVerseCluster', {
      vpc,
      clusterName: 'drawvidverse-cluster',
    });

    // ========================================================================
    // ECR Repository for world server
    // ========================================================================
    const worldserverRepo = new ecr.Repository(this, 'WorldserverRepo', {
      repositoryName: 'drawvidverse-worldserver',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // ========================================================================
    // Security Group for world server tasks
    // ========================================================================
    const worldserverSecurityGroup = new ec2.SecurityGroup(
      this,
      'WorldserverSecurityGroup',
      {
        vpc,
        description: 'Security group for world server tasks',
        allowAllOutbound: true,
      }
    );

    // Allow inbound on port 7777 (WebSocket)
    worldserverSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(7777),
      'Allow world server WebSocket connections'
    );

    // ========================================================================
    // ECS Task Definition
    // ========================================================================
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      'WorldserverTaskDef',
      {
        memoryLimitMiB: 512,
        cpu: 256,
      }
    );

    // Grant task permission to stop itself
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:StopTask'],
        resources: ['*'],
      })
    );

    // Grant task permission to read/write bootstrap in DynamoDB
    table.grantReadWriteData(taskDefinition.taskRole);

    const worldserverContainer = taskDefinition.addContainer('worldserver', {
      image: ecs.ContainerImage.fromEcrRepository(worldserverRepo, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'worldserver',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        DDB_TABLE: table.tableName,
        WORLD_STORE_MODE: 'dynamodb',
      },
      // Secrets and other env vars will be passed via RunTask overrides
    });

    worldserverContainer.addPortMappings({
      containerPort: 7777,
      protocol: ecs.Protocol.TCP,
    });

    // ========================================================================
    // Create target group first (before Lambda env) so we can pass ARN
    // ========================================================================
    const worldServerTargetGroup = new elbv2.NetworkTargetGroup(
      this,
      'WorldServerTargetGroup',
      {
        vpc,
        port: 7777,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          enabled: true,
          healthyThresholdCount: 3,
          unhealthyThresholdCount: 3,
          interval: cdk.Duration.seconds(6),
          timeout: cdk.Duration.seconds(5),
          protocol: elbv2.Protocol.TCP,
        },
      }
    );

    // Enable stickiness to ensure clients always connect to the same world server task
    worldServerTargetGroup.setAttribute('stickiness.enabled', 'true');
    worldServerTargetGroup.setAttribute('stickiness.type', 'source_ip');
    worldServerTargetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
    // ========================================================================
    const lambdaEnv = {
      TABLE_NAME: table.tableName,
      ECS_CLUSTER_ARN: cluster.clusterArn,
      TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
      SUBNETS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
      SECURITY_GROUP: worldserverSecurityGroup.securityGroupId,
      TARGET_GROUP_ARN: worldServerTargetGroup.targetGroupArn,
      JWT_SECRET: jwtSecret.secretValue.unsafeUnwrap(), // In production, use fromSecretsManager
      [`GAME_CONFIG_${gameKey.toUpperCase()}`]: JSON.stringify(gameConfig),
    };

    const connectHandler = new lambda.Function(this, 'ConnectHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../dist/lambda-bundle'),
      handler: 'connect.handler',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
    });

    const disconnectHandler = new lambda.Function(this, 'DisconnectHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../dist/lambda-bundle'),
      handler: 'disconnect.handler',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
    });

    const defaultHandler = new lambda.Function(this, 'DefaultHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../dist/lambda-bundle'),
      handler: 'default.handler',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(10),
    });

    const messageHandler = new lambda.Function(this, 'MessageHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../dist/lambda-bundle'),
      handler: 'message.handler',
      environment: lambdaEnv,
      timeout: cdk.Duration.seconds(300), // Long timeout for task launch
    });

    // Cleanup Lambda - runs periodically to stop idle worlds
    const cleanupHandler = new lambda.Function(this, 'CleanupHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('../dist/lambda-bundle'),
      handler: 'cleanup.handler',
      environment: {
        TABLE_NAME: table.tableName,
        CLUSTER_ARN: cluster.clusterArn,
      },
      timeout: cdk.Duration.seconds(60),
    });

    // Grant permissions
    table.grantReadWriteData(connectHandler);
    table.grantReadWriteData(disconnectHandler);
    table.grantReadWriteData(defaultHandler);
    table.grantReadWriteData(messageHandler);
    table.grantReadWriteData(cleanupHandler);

    jwtSecret.grantRead(messageHandler);

    // Grant ECS permissions to message handler
    messageHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:RunTask',
          'ecs:DescribeTasks',
          'ec2:DescribeNetworkInterfaces',
          'ec2:AllocateAddress',
          'ec2:AssociateAddress',
          'elasticloadbalancing:RegisterTargets',
          'iam:PassRole',
        ],
        resources: ['*'],
      })
    );

    // Grant ECS permissions to cleanup handler
    cleanupHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ecs:StopTask',
          'ecs:DescribeTasks',
        ],
        resources: ['*'],
      })
    );

    // Schedule cleanup Lambda to run every 5 minutes
    new events.Rule(this, 'CleanupSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new targets.LambdaFunction(cleanupHandler)],
    });

    // Grant EventBridge permission to invoke cleanup Lambda
    cleanupHandler.grantInvoke(new iam.ServicePrincipal('events.amazonaws.com'));

    // ========================================================================
    // WebSocket API
    // ========================================================================
    const webSocketApi = new apigatewayv2.WebSocketApi(this, 'DrawvidVerseWsApi', {
      apiName: 'drawvidverse-lobby',
      // routeSelectionExpression is for selecting routes based on message content
      // Use $request.body.t to route based on the 't' field in the message body
      routeSelectionExpression: '$request.body.t',
      connectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'ConnectIntegration',
          connectHandler
        ),
      },
      disconnectRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DisconnectIntegration',
          disconnectHandler
        ),
      },
      defaultRouteOptions: {
        integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
          'DefaultIntegration',
          defaultHandler
        ),
      },
    });

    // --- Escape hatch: inject requestTemplates for $connect route ---
    const connectIntegrationConstruct = webSocketApi.node.tryFindChild('ConnectIntegration');
    if (connectIntegrationConstruct && 'node' in connectIntegrationConstruct && connectIntegrationConstruct.node.defaultChild) {
      const cfnConnectIntegration = connectIntegrationConstruct.node.defaultChild as apigatewayv2.CfnIntegration;
      (cfnConnectIntegration as any).requestTemplates = {
        'application/json': `{
          "headers": {
            #foreach($header in $input.params().header.keySet())
              "$header": "$util.escapeJavaScript($input.params().header.get($header))"#if($foreach.hasNext),#end
            #end
          },
          "requestContext": $util.toJson($context.requestContext),
          "isBase64Encoded": false
        }`
      };
    }

    // Add message routes
    webSocketApi.addRoute('createWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'CreateWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('joinWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'JoinWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('leaveWorld', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'LeaveWorldIntegration',
        messageHandler
      ),
    });

    webSocketApi.addRoute('ping', {
      integration: new apigatewayv2Integrations.WebSocketLambdaIntegration(
        'PingIntegration',
        defaultHandler
      ),
    });

    const stage = new apigatewayv2.WebSocketStage(this, 'ProdStage', {
      webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // ========================================================================
    // Route53 Custom Domain with API Gateway Custom Domain + ACM
    // ========================================================================
    // Import existing Route53 hosted zone for drawvid.com
    const hostedZone = route53.HostedZone.fromLookup(this, 'DrawvidHostedZone', {
      domainName: 'drawvid.com',
    });

    // Import the wildcard ACM certificate from us-east-2
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'DrawvidWildcardCert',
      'arn:aws:acm:us-east-2:593615615124:certificate/a5b44baf-5840-40d5-8167-46417bf29d77'
    );

    // Create API Gateway custom domain for matchmaker.drawvid.com
    const matchmakerDomain = new apigatewayv2.DomainName(this, 'MatchmakerDomain', {
      domainName: 'matchmaker.drawvid.com',
      certificate: certificate,
    });

    // Create API mapping for the custom domain
    new apigatewayv2.ApiMapping(this, 'MatchmakerApiMapping', {
      api: webSocketApi,
      domainName: matchmakerDomain,
      stage: stage,
    });

    // Create Route53 A record pointing to matchmaker domain
    new route53.ARecord(this, 'MatchmakerDomainRecord', {
      zone: hostedZone,
      recordName: 'matchmaker',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          matchmakerDomain.regionalDomainName,
          matchmakerDomain.regionalHostedZoneId
        )
      ),
    });

    // ========================================================================
    // Network Load Balancer for World Servers
    // ========================================================================
    const worldServerNLB = new elbv2.NetworkLoadBalancer(
      this,
      'WorldServerNLB',
      {
        vpc,
        internetFacing: true,
        loadBalancerName: 'drawvidverse-worldserver-nlb',
      }
    );

    // Target group already created above (for Lambda env)

    // Add TLS listener on port 443 (NLB terminates TLS and forwards plain TCP to target group)
    worldServerNLB.addListener('WorldServerListener', {
      port: 443,
      protocol: elbv2.Protocol.TLS,
      certificates: [
        elbv2.ListenerCertificate.fromArn(
          'arn:aws:acm:us-east-2:593615615124:certificate/a5b44baf-5840-40d5-8167-46417bf29d77'
        ),
      ],
      defaultTargetGroups: [worldServerTargetGroup],
    });

    // Also allow direct TCP on 7777 for future use or testing
    worldServerNLB.addListener('WorldServerDirectListener', {
      port: 7777,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [worldServerTargetGroup],
    });

    // Create Route53 alias record pointing to NLB
    new route53.ARecord(this, 'WorldServerARecord', {
      zone: hostedZone,
      recordName: 'world',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.LoadBalancerTarget(worldServerNLB)
      ),
    });

    // Grant API Gateway invoke permissions to lambdas
    const apiGatewayManagementEndpoint = `https://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/${stage.stageName}`;

    [connectHandler, disconnectHandler, defaultHandler, messageHandler].forEach((fn) => {
      fn.addEnvironment('WEBSOCKET_ENDPOINT', apiGatewayManagementEndpoint);

      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['execute-api:ManageConnections'],
          resources: [
            `arn:aws:execute-api:${this.region}:${this.account}:${webSocketApi.apiId}/${stage.stageName}/*`,
          ],
        })
      );
    });

    // ========================================================================
    // Outputs
    // ========================================================================
    new cdk.CfnOutput(this, 'WebSocketApiUrl', {
      value: stage.url,
      description: 'WebSocket API URL',
    });

    new cdk.CfnOutput(this, 'CustomDomainUrl', {
      value: `wss://matchmaker.drawvid.com/prod`,
      description: 'Matchmaker WebSocket URL',
    });

    new cdk.CfnOutput(this, 'WorldServerUrl', {
      value: `wss://world.drawvid.com:443`,
      description: 'World Server WebSocket URL',
    });

    new cdk.CfnOutput(this, 'DdbTableName', {
      value: table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'ClusterArn', {
      value: cluster.clusterArn,
      description: 'ECS Cluster ARN',
    });

    new cdk.CfnOutput(this, 'TaskDefinitionArn', {
      value: taskDefinition.taskDefinitionArn,
      description: 'ECS Task Definition ARN',
    });

    new cdk.CfnOutput(this, 'WorldserverRepoUri', {
      value: worldserverRepo.repositoryUri,
      description: 'ECR repository URI for world server',
    });

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: `cyberia-drawvid-frontend-${this.account}`,
      description: 'S3 bucket for frontend hosting',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: 'https://cyberia.drawvid.com',
      description: 'Frontend URL (served via S3 website endpoint)',
    });

    new cdk.CfnOutput(this, 'WorldsTableName', {
      value: table.tableName,
      description: 'DynamoDB table name for worlds',
    });

    new cdk.CfnOutput(this, 'WorldServerTargetGroupArn', {
      value: worldServerTargetGroup.targetGroupArn,
      description: 'NLB Target Group ARN for world server tasks',
    });
  }
}
